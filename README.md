# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de provedores de jogos, recebidas por HTTP e por SQS (FIFO), e mantém carteiras (`wallets`) com ledger append-only. O sistema continua correto com mensagens duplicadas, fora de ordem, várias instâncias processando ao mesmo tempo, crash antes ou depois do commit e indisponibilidade temporária de PostgreSQL ou SQS. A stack é Bun 1.4 + TypeScript `strict` + NestJS 12 + MikroORM 7 + PostgreSQL 17 + SQS (LocalStack). O sistema roda como três serviços independentes (`api`, `consumer`, `workers`) a partir do mesmo código.

As decisões, os trade-offs e as limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pré-requisitos

- **Bun 1.4.x** (o `Dockerfile` usa `oven/bun:1.4.4`). Necessário para os testes e para rodar fora do Docker.
- **Docker** com **Compose v2** (o `--wait` é usado nos comandos abaixo).
- Para os exemplos deste README: `curl`, `uuidgen` e `jq` (o `jq` é opcional: serve só para extrair ids das respostas).
- Não é preciso ter a AWS CLI no host. As mensagens SQS são publicadas com o `awslocal` que já vem dentro do container do LocalStack.

## Início rápido

```bash
bun install
docker compose up -d --build --scale consumer=3 --scale workers=2 --wait
curl -s http://localhost:3000/health/ready
# {"status":"ok","checks":{"database":"up","queue":"up"}}
```

O `--wait` só retorna quando todos os containers estão `healthy`. Com as imagens em cache leva uns 15 s; o primeiro build demora mais.

| Serviço (projeto Compose `wagering`) | O que faz | Porta no host |
|---|---|---|
| `postgres` | PostgreSQL 17 (`max_connections=300`) | `5433` (usuário/senha `postgres`/`postgres`, banco `wagering`) |
| `localstack` | SQS. O script `infra/localstack/init/ready.d/01-queues.sh` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount=5`) e `wallet-events.fifo` | `4567` |
| `migrate` | Roda `bun src/main.migrate.ts up` e termina; os serviços de aplicação só sobem depois dele | — |
| `api` | API HTTP (`src/main.api.ts`) | `3000` |
| `consumer` | Consome `wager-transactions.fifo` (`src/main.consumer.ts`); expõe health/metrics na porta interna `3001` | — |
| `workers` | Outbox publisher + worker de `PENDING_REFERENCE` (`src/main.workers.ts`); health/metrics na porta interna `3002` | — |
| `keycloak` | Opcional, só com `--profile auth`: IdP para a [autenticação](#autenticação-opcional-keycloak) | `8080` |

Comandos úteis:

```bash
docker compose ps                                   # estado e health de cada réplica
docker compose logs -f consumer                     # logs JSON (pino) de todas as réplicas do consumer
docker compose exec -T workers bun -e \
  "console.log(await (await fetch('http://localhost:3002/metrics')).text())"   # /metrics de uma réplica interna
docker compose down -v                              # derruba tudo e apaga os volumes
```

> O `docker compose down -v` também é o que `bun run test:e2e` executa ao terminar. Não rode o E2E com uma stack de desenvolvimento que você quer manter (as duas usam o projeto `wagering`).

## API HTTP

Todos os valores monetários trafegam como `{"amount": "<decimal com exatamente 2 casas>", "currency": "<ISO-4217>"}`. `"10"`, `"10.5"`, `"1e3"` e `"-1.00"` são rejeitados com 400. Ids de wallet e player são UUIDs, aceitos em qualquer caixa e normalizados para minúsculas na entrada (corpo, path e mensagens SQS). Erros saem como `application/problem+json` (RFC 9457) com `code`, `retryable` e `correlationId`. Toda resposta devolve o header `x-request-id`: é o que veio na requisição (se curto e seguro para log) ou um novo UUID v7.

Os exemplos usam estas variáveis:

```bash
API=http://localhost:3000
RUN=$(date +%s)                                      # sufixo para não colidir chaves entre execuções
PLAYER_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
```

### Wallets

```bash
# Abrir wallet → 201 {id, playerId, balance, version}. Saldo inicial > 0 gera um lançamento OPENING.
WALLET_ID=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)

# Mesma (playerId, currency) de novo → 409 WALLET_ALREADY_EXISTS (o problem não traz o walletId; ver interpretação 21 do ARCHITECTURE.md)
curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"0.00\",\"currency\":\"BRL\"}}"

# Consultar → 200 {id, playerId, balance, version}; inexistente → 404 NOT_FOUND
curl -s $API/wallets/$WALLET_ID

# Ledger paginado por cursor (ordem crescente de walletVersion; limit padrão 50, máximo 200)
curl -s "$API/wallets/$WALLET_ID/ledger?limit=2"
# → {"items":[...], "nextCursor":"eyJ2IjoyfQ"}   (null na última página)
curl -s "$API/wallets/$WALLET_ID/ledger?limit=2&cursor=eyJ2IjoyfQ"

# Reconciliação: compara o saldo gravado com Σ créditos − Σ débitos do ledger. Sempre 200; nunca corrige nada.
curl -s -X POST $API/wallets/$WALLET_ID/reconciliation
# → {"walletId":"…","storedBalance":{…},"calculatedBalance":{…},"difference":{"amount":"0.00",…},"consistent":true,"checkedEntries":6}
```

### Transações de aposta

`POST /wagering/transactions` exige o header `Idempotency-Key` (1–255 caracteres). A chave é global, não por provedor: provedores devem usar UUIDs. A resposta é sempre `{transactionId, status, balance, failureCode?, idempotentReplay}`, e o status HTTP segue o status da transação: `PROCESSED` → 200, `PENDING_REFERENCE` → 202, `REJECTED` → 422.

```bash
# BET de 25.00 → 200 PROCESSED, balance 75.00
curl -s -i -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: bet-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"bet-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round-$RUN","gameId":"game-1","kind":"BET",
 "money":{"amount":"25.00","currency":"BRL"}}
EOF
```

Reenviar exatamente o mesmo comando devolve o mesmo status e o mesmo corpo de uma transação já decidida (um `PENDING_REFERENCE` já resolvido devolve a decisão), com `"idempotentReplay": true` e o header `Idempotent-Replayed: true`, e não debita de novo. Com a mesma chave e qualquer campo de negócio diferente (por exemplo `"amount":"30.00"`), a resposta é 409 `IDEMPOTENCY_KEY_REUSED`. O mesmo `(providerId, externalTransactionId)` com outra chave dá 409 `EXTERNAL_ID_CONFLICT`.

```bash
# WIN de 50.00 referenciando a BET → 200, balance 125.00
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: win-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"win-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round-$RUN","gameId":"game-1","kind":"WIN",
 "money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"bet-$RUN"}
EOF

# ROLLBACK do WIN (mesmo valor da referência) → 200, balance 75.00
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: rollback-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"rollback-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round-$RUN","gameId":"game-1","kind":"ROLLBACK",
 "money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"win-$RUN"}
EOF

# BET maior que o saldo → 422 REJECTED, failureCode INSUFFICIENT_FUNDS (persistida; o replay devolve o mesmo 422)
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: bet-big-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"bet-big-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round-$RUN","gameId":"game-1","kind":"BET",
 "money":{"amount":"1000.00","currency":"BRL"}}
EOF

# REFUND que chega antes da sua BET → 202 PENDING_REFERENCE
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: refund-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"refund-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round2-$RUN","gameId":"game-1","kind":"REFUND",
 "money":{"amount":"10.00","currency":"BRL"},"referenceExternalTransactionId":"bet2-$RUN"}
EOF
# … a BET chega → 200 PROCESSED (balance 65.00). O worker liquida o REFUND em seguida (balance 75.00).
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "Idempotency-Key: bet2-$RUN" \
  -d @- <<EOF
{"providerId":"provider-a","externalTransactionId":"bet2-$RUN","playerId":"$PLAYER_ID",
 "walletId":"$WALLET_ID","roundId":"round2-$RUN","gameId":"game-1","kind":"BET",
 "money":{"amount":"10.00","currency":"BRL"}}
EOF

# Sem Idempotency-Key (corpo válido) → 400 MISSING_IDEMPOTENCY_KEY; corpo inválido → 400 INVALID_PAYLOAD
```

Consultas:

```bash
# Por provedor + id externo → 200 com status, failureCode, referenceTransactionId, observedBalance, …
curl -s $API/providers/provider-a/wagering/transactions/refund-$RUN

# Por id interno
TX_ID=$(curl -s $API/providers/provider-a/wagering/transactions/bet-$RUN | jq -r .id)
curl -s $API/wagering/transactions/$TX_ID
```

### Operação

| Endpoint | Resposta |
|---|---|
| `GET /health/live` | 200 `{"status":"ok"}` enquanto o processo vive |
| `GET /health/ready` | 200 com `SELECT 1` no Postgres e `GetQueueAttributes` na fila de apostas (timeout de 2 s cada); senão 503 com `checks.database` / `checks.queue` = `down` |
| `GET /metrics` | Prometheus (`wagering_transactions_total`, `wagering_duplicates_total`, `db_lock_conflicts_total`, `outbox_lag_seconds`, …) |

Os três ficam fora de autenticação, também com `AUTH_MODE=keycloak`. `consumer` e `workers` expõem os mesmos três num servidor HTTP mínimo, nas portas internas 3001 e 3002. As métricas são por processo: cada réplica tem as suas.

## Autenticação (opcional, Keycloak)

Por padrão (`AUTH_MODE=none`) a API não exige token e qualquer chamador pode agir como qualquer provedor. Com `AUTH_MODE=keycloak`, todo endpoint HTTP exceto `/health/*` e `/metrics` exige `Authorization: Bearer <JWT>` emitido pelo realm `wagering` de um Keycloak externo. Não existe tabela de usuários nem senhas no serviço (C#31): cada provedor é um client `confidential` do Keycloak que obtém token por *client credentials*.

```bash
AUTH_MODE=keycloak docker compose --profile auth up -d --build --scale consumer=3 --scale workers=2 --wait

# Token do provider-a (o secret é só de teste: está em infra/keycloak/realm-wagering.json)
TOKEN=$(curl -s http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-test-secret | jq -r .access_token)

curl -s -X POST $API/wallets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
# Sem token → 401 UNAUTHENTICATED (com WWW-Authenticate: Bearer)
# Token do provider-a com "providerId":"provider-b" no corpo do POST /wagering/transactions → 403 PROVIDER_MISMATCH
```

Com a autenticação ligada, os demais exemplos deste README precisam de `-H "Authorization: Bearer $TOKEN"` (e de `providerId` igual ao client do token). O token dura 5 min.

| Situação | Resposta |
|---|---|
| Sem header, esquema diferente de `Bearer`, token malformado, assinatura inválida, `iss` diferente de `KEYCLOAK_ISSUER`, `aud` sem `wagering-api`, expirado ou sem `azp` | 401 `UNAUTHENTICATED`, `retryable: false` |
| `POST /wagering/transactions` com `providerId` diferente do client do token (`azp`) | 403 `PROVIDER_MISMATCH`, nada é gravado |
| JWKS do Keycloak inacessível | 503 `SERVICE_UNAVAILABLE`, `retryable: true` (a falha é do IdP, não da credencial) |

O realm importado (`infra/keycloak/realm-wagering.json`) tem os clients `provider-a` e `provider-b`, com um mapper que põe `wagering-api` no `aud`, e `other-service`, sem esse mapper (serve para testar o 401 por audiência). Todos os secrets do realm e o admin `admin`/`admin` do Keycloak são **só de teste**. O `iss` dos tokens é sempre `http://localhost:8080/realms/wagering` (hostname v2 do Keycloak fixado em `KC_HOSTNAME`), seja o token pedido do host ou de dentro da rede do Compose; a `api` busca as chaves em `http://keycloak:8080/...` (`KEYCLOAK_JWKS_URL`).

O que **não** é protegido por provedor: as consultas (`GET`) exigem um token válido, mas qualquer provedor autenticado lê wallets e transações de qualquer outro; `POST /wallets` também aceita qualquer token válido. A fila SQS não passa pelo guard: a confiança nela é de IAM (quem pode publicar em `wager-transactions.fifo`), e o `providerId` da mensagem só passa pelas validações de domínio. Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md#autenticação).

## SQS

O consumer lê `wager-transactions.fifo`. O corpo da mensagem é um envelope cujo `data` é o corpo do `POST /wagering/transactions` **mais** `idempotencyKey`:

```json
{
  "messageId": "6f1c1f9e-3a5e-4d47-9a51-0c3b2f0d9c11",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-11T20:00:00Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "sqs-bet-1",
    "idempotencyKey": "sqs-bet-1",
    "playerId": "41d83f29-f27a-42fc-a0e0-2575f3c6027b",
    "walletId": "01a1cc30-7120-7603-8771-4f34245e7332",
    "roundId": "round-sqs-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" }
  }
}
```

Produtores usam `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. Publicando de dentro do container do LocalStack (os comandos usam as variáveis da seção anterior):

```bash
QUEUE=http://localhost:4566/000000000000/wager-transactions.fifo   # URL vista de dentro do container
MESSAGE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
BODY=$(cat <<EOF
{"messageId":"$MESSAGE_ID","type":"WagerTransactionRequested","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "data":{"providerId":"provider-a","externalTransactionId":"sqs-bet-$RUN","idempotencyKey":"sqs-bet-$RUN",
         "playerId":"$PLAYER_ID","walletId":"$WALLET_ID","roundId":"round-sqs-$RUN","gameId":"game-1",
         "kind":"BET","money":{"amount":"5.00","currency":"BRL"}}}
EOF
)
docker compose exec -T localstack awslocal sqs send-message --queue-url "$QUEUE" \
  --message-group-id "$WALLET_ID" --message-deduplication-id "$MESSAGE_ID" --message-body "$BODY"

# Resultado, pela API (em ~1 s)
curl -s $API/providers/provider-a/wagering/transactions/sqs-bet-$RUN

# Eventos publicados pelo outbox (envelopes WagerTransactionProcessed, WalletBalanceChanged, …)
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wallet-events.fifo \
  --max-number-of-messages 10 --query 'Messages[].Body' --output json

# Mensagem inválida → vai para a DLQ com o atributo reason
docker compose exec -T localstack awslocal sqs send-message --queue-url "$QUEUE" \
  --message-group-id poison --message-deduplication-id "poison-$RUN" --message-body '{"hello":"world"}'
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --message-attribute-names reason --query 'Messages[].[Body, MessageAttributes.reason.StringValue]' --output text
# {"hello":"world"}	INVALID_PAYLOAD
```

Do host, a mesma fila fica em `http://localhost:4567/000000000000/wager-transactions.fifo` (qualquer cliente SQS com credenciais `test`/`test`, região `us-east-1`).

## Testes

| Script | O que sobe | O que roda | Duração aproximada* |
|---|---|---|---|
| `bun run typecheck` | nada | `tsc --noEmit` (`strict`). O Bun não faz type-check | ~2 s |
| `bun run test:unit` | nada | `test/unit`: domínio, hashing, backoff, classificação do consumer, mapeamento de erros, env, guard JWT (com JWKS local), sem IO | <1 s |
| `bun run test:integration` | `compose.test.yml` (projeto `wagering-test`: Postgres em `55432`, LocalStack em `4566`) | `test/integration`, com Postgres e LocalStack reais. Cada arquivo clona um banco migrado (`CREATE DATABASE … TEMPLATE`) e cria filas próprias | ~30 s (com skips: o smoke do Compose só roda no E2E e o teste de Keycloak só com `AUTH_E2E=1`) |
| `bun run test:concurrency` | `compose.test.yml` | `test/concurrency`: os 8 cenários obrigatórios com processos reais (`Bun.spawn` de `api`/`consumer`/`workers`) | ~20 s |
| `bun run test:e2e` | `compose.yml` inteiro com `--build --scale consumer=3 --scale workers=2 --wait`; ao final, `docker compose down -v` | `test/e2e` + `test/integration/runtime` (`E2E_COMPOSE=1`), interagindo só por HTTP e SQS | ~45 s com imagens em cache |
| `bun run test:auth` | `keycloak` (`docker compose --profile auth up -d --wait keycloak`) e `compose.test.yml`; ao final, remove só o container do Keycloak | `test/integration/http/auth.test.ts` com `AUTH_E2E=1`: API em processo com `AUTH_MODE=keycloak` contra o Keycloak real (sem token → 401, token sem audiência ou lixo → 401, provedor errado → 403, provedor certo → 200, health/metrics sem token) | ~20 s |
| `bun run test:load` | Para cada cenário, uma stack nova de `compose.yml` + `compose.load.yml` (limites fixos de CPU/memória) e, ao final, `docker compose down -v` | k6 (`grafana/k6:2.3.0`, em container na rede do Compose) com os cenários `distributed`, `hot-wallet`, `duplicates` e `sqs-drain` (`--scenario soak` roda o soak de 10 min). Coleta `/metrics`, `pg_stat_activity` e `docker stats`; reconcilia todas as wallets e falha se alguma estiver inconsistente. Resultados em `test/load/results/<timestamp>/` (fora do git); análise em [`docs/load-test-report.md`](docs/load-test-report.md) | ~22 min (soak: ~12 min) |
| `bun run test` | tudo acima, exceto `test:auth` e `test:load` (roda com `AUTH_MODE=none`) | `typecheck → test:unit → test:integration → test:concurrency → test:e2e` | ~1,5 min |
| `bun run infra:test:up` / `infra:test:down` | sobe / derruba (`-v`) só o `compose.test.yml` | — | — |
| `bun run db:migrate` / `db:migrate:down` | nada | aplica / reverte as migrations em `DATABASE_URL` | — |

\* Medido num MacBook (Apple Silicon) com as imagens Docker já baixadas.

A infra de teste (`wagering-test`, portas 55432/4566) e a stack da aplicação (`wagering`, portas 5433/4567/3000) têm nomes de projeto e portas distintos e podem rodar lado a lado. `test:integration` e `test:concurrency` deixam a infra de teste rodando; para derrubá-la, use `bun run infra:test:down`. A URL do servidor Postgres de teste pode ser trocada com `TEST_DATABASE_SERVER_URL` (padrão `postgres://postgres:postgres@localhost:55432`).

Testes de carga (`bun run test:load [--scenario <nome>] [--consumers N] [--rate N] [--levels a,b,c] [--messages N] [--minutes N]`):

- Pré-requisitos: só Docker e Bun no host (o k6 roda na imagem `grafana/k6:2.3.0`; o módulo `k6-jslib-aws` 0.14.0 é baixado de `jslib.k6.io`, então é preciso internet). A VM do Docker precisa de pelo menos 4 CPUs e 6 GB. Rode com a máquina ociosa: os limites somam mais CPU que a VM tem, e qualquer outra carga entra na medição.
- Usa o projeto Compose `wagering`, como o E2E: não rode com uma stack de desenvolvimento que você quer manter, nem junto com `test:e2e`.
- Cenários: `distributed` (escada de 100 a 700 req/s sobre 1.000 wallets), `hot-wallet` (10 wallets e 1 wallet), `duplicates` (~30% de reenvios), `sqs-drain` ou `drain` (50 mil mensagens, `consumer=1` e depois `consumer=3`; `--consumers N` mede só N) e `soak` (10 min a ~50% do throughput máximo medido pelo último `distributed`, ou `--rate`).
- Ctrl-C (SIGINT/SIGTERM) derruba a stack, como uma falha faz. `bun test/load/rerender.ts <diretório>` regenera o `summary.md` de uma rodada a partir dos JSONs salvos, sem rodar carga.
- O processo termina com código ≠ 0 se um threshold do k6 falhar (checks de correção < 100%; erro > 1% nos cenários fora da escada do `distributed`; qualquer 5xx ou 4xx inesperado no `distributed`), se alguma wallet não reconciliar, se o número de replays contados pelo serviço (`wagering_duplicates_total`) diferir do número de duplicatas enviadas, ou se a drenagem perder, duplicar ou mandar para a DLQ alguma mensagem.

Toda suíte não unitária termina verificando `wallet.balance == saldo reconstruído pelo ledger` em todas as wallets tocadas.

## Rodar fora do Docker

Com a infra de teste no ar (`bun run infra:test:up`), os padrões das variáveis já apontam para o LocalStack em `localhost:4566`, e só `DATABASE_URL` é obrigatória:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/wagering
bun run db:migrate
PORT=3100 bun src/main.api.ts       # API
PORT=3101 bun src/main.consumer.ts  # consumer (health/metrics em 3101)
PORT=3102 bun src/main.workers.ts   # outbox publisher + pending reference (health/metrics em 3102)
```

O `.env.example` lista as mesmas variáveis. O Bun carrega `.env` automaticamente, se existir.

## Variáveis de ambiente

Validadas por `loadEnv` (`src/infrastructure/config/env.ts`, zod). Um valor inválido derruba o processo na partida com a lista de erros.

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | **obrigatória** | URL do PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | Endpoint SQS. Com endpoint definido, o cliente usa credenciais estáticas `test`/`test` (ver Limitações) |
| `AWS_REGION` | `us-east-1` | Região do cliente SQS |
| `WAGER_QUEUE_URL` | `http://localhost:4566/000000000000/wager-transactions.fifo` | Fila de entrada; também usada no readiness |
| `WAGER_DLQ_URL` | `http://localhost:4566/000000000000/wager-transactions-dlq.fifo` | DLQ para onde o consumer envia erros permanentes |
| `EVENTS_QUEUE_URL` | `http://localhost:4566/000000000000/wallet-events.fifo` | Destino do outbox publisher |
| `PORT` | `3000` | Porta HTTP (API, ou o servidor de health/metrics do consumer/workers) |
| `CONSUMER_NAME` | `wager-transactions-consumer` | Nome lógico do consumer na chave da inbox `(consumer_name, message_id)` |
| `SQS_VISIBILITY_TIMEOUT_S` | `30` | `VisibilityTimeout` pedido no `ReceiveMessage` |
| `SQS_MAX_RECEIVE` | `5` | Validada, mas sem efeito hoje: o limite real é o `maxReceiveCount=5` da redrive policy criada no init do LocalStack |
| `SHUTDOWN_GRACE_MS` | `20000` | Tempo que o consumer espera as mensagens em voo no `SIGTERM` (o Compose usa `stop_grace_period: 30s`) |
| `OUTBOX_BATCH` | `50` | Mensagens por lote do outbox publisher |
| `OUTBOX_POLL_MS` | `250` | Espera do publisher quando não há nada vencido |
| `PENDING_REF_BATCH` | `20` | Candidatos `PENDING_REFERENCE` por iteração |
| `PENDING_REF_POLL_MS` | `500` | Espera do worker de pendências quando não há nada vencido |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | Tentativas do worker antes de `REJECTED REFERENCE_NOT_FOUND` |
| `PENDING_REF_TTL_MS` | `900000` (15 min) | Idade máxima de uma pendência desde `created_at` |
| `DB_POOL_MAX` | `20` | Conexões por processo |
| `FAULT` | — | Só para testes: `<ponto>:<crash\|throw>`, com ponto em `after_ledger_append`, `before_commit`, `after_commit_before_ack`, `after_publish_before_mark` |
| `JITTER` | `on` | `off` desliga o jitter dos backoffs (testes determinísticos) |
| `LOG_LEVEL` | `info` | Nível do pino (`fatal` … `trace`, `silent`) |
| `AUTH_MODE` | `none` | `none`: sem autenticação. `keycloak`: JWT obrigatório na API exceto health/metrics (ver [Autenticação](#autenticação-opcional-keycloak)) |
| `KEYCLOAK_ISSUER` | — | Obrigatória com `AUTH_MODE=keycloak`: `iss` esperado (`http://localhost:8080/realms/wagering` no Compose) |
| `KEYCLOAK_JWKS_URL` | — | Obrigatória com `AUTH_MODE=keycloak`: URL do JWKS do realm (`http://keycloak:8080/realms/wagering/protocol/openid-connect/certs` dentro do Compose) |

`lock_timeout` (5 s) e `statement_timeout` (15 s) por transação são constantes de `MikroOrmUnitOfWork`, não variáveis de ambiente.

## Estrutura do projeto

```
src/
  domain/            TS puro: Money, Wallet, WalletLedgerEntry, WagerTransaction, WagerSettlement,
                     eventos de integração, InboxMessage, OutboxMessage, backoff, FailureCode
  application/       use cases (SubmitWagerTransaction, OpenWallet, RetryPendingReferences, PublishOutbox,
                     ReconcileWallet, consultas), ports, hashing canônico, erros de aplicação
  infrastructure/    MikroORM (schemas defineEntity, mappers, repositórios, UnitOfWork, migration),
                     SQS (client, publisher), observabilidade (pino, prom-client, health), auth (no-op e JWT Keycloak), config
  interfaces/        http (controllers, zod, problem+json), sqs (consumer), workers (laços de polling)
  main.api.ts  main.consumer.ts  main.workers.ts  main.migrate.ts
test/
  unit/  integration/  concurrency/  e2e/  load/  support/
infra/localstack/init/ready.d/01-queues.sh     criação das filas
infra/keycloak/realm-wagering.json             realm do Keycloak opcional (secrets só de teste)
compose.yml  compose.test.yml  compose.load.yml  Dockerfile  mikro-orm.config.ts
```

## Documentos

- [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões, trade-offs, interpretações e limitações.
- [`docs/load-test-report.md`](docs/load-test-report.md): relatório dos testes de carga (ambiente, metodologia, resultados, gargalos e limitações).
- [`docs/constitution.md`](docs/constitution.md): regras invioláveis do projeto.
- [`docs/superpowers/specs/2026-11-10-wagering-processor-design.md`](docs/superpowers/specs/2026-11-10-wagering-processor-design.md): spec de design.
- [`docs/superpowers/plans/2026-11-11-wagering-processor.md`](docs/superpowers/plans/2026-11-11-wagering-processor.md): plano de implementação.
