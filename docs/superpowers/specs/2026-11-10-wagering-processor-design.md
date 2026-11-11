# Design — Distributed Wagering Processor

- **Data:** 2026-11-10
- **Status:** aprovado em brainstorming, aguardando revisão da spec escrita
- **Desafio:** https://github.com/junglegaming/backend-challenge (README é a fonte dos requisitos)
- **Prazo de entrega:** ~2026-11-12 17:42
- **Regras invioláveis:** [`docs/constitution.md`](../../constitution.md) — vence qualquer conflito com este documento

---

## 1. Objetivo e critérios de sucesso

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores via HTTP e SQS, permanecendo correto com mensagens duplicadas, fora de ordem, processamento simultâneo em ≥3 instâncias, crash antes/depois do commit e indisponibilidade temporária de PostgreSQL/SQS.

Sucesso =

1. Nenhuma falha eliminatória do README (seção 14).
2. Os 8 cenários de concorrência obrigatórios (README §13) passando com paralelismo real.
3. Invariante `wallet.balance == saldo reconstruído pelo ledger` verificada ao fim de toda suíte não-unitária.
4. `README.md` (setup e comandos) e `ARCHITECTURE.md` (decisões, trade-offs, limitações) completos.
5. Diferenciais na ordem: E2E → testes de carga com relatório → Keycloak.

## 2. Decisões tomadas

| Tema | Decisão | Motivo principal |
|---|---|---|
| Runtime | Bun 1.4.x, TypeScript `strict`, NestJS 12 | Stack obrigatória; spike validou a combinação |
| ORM | MikroORM 7 com `defineEntity` (sem decorators) | Preferencial no README; persistência separada do domínio sem decorators |
| Topologia | Um repositório, 3 serviços: `api`, `consumer`, `workers` | Escala independente; prova multi-instância por papel |
| Arquitetura | Monólito modular hexagonal | Domínio testável sem IO; mesmo use case para HTTP e SQS |
| Concorrência | `SELECT … FOR UPDATE` por wallet + `CHECK (balance >= 0)` + `version++` | Determinístico em hot wallet, sem retry; banco como última barreira |
| Money | Implementação própria em `bigint` (centavos) | Exato, sem dependência |
| Idempotência | Índices únicos + inbox persistente + `observed_balance` para replay | Persistente e multi-instância |
| Eventos | Transactional outbox → `wallet-events.fifo` com `FOR UPDATE SKIP LOCKED` | Atomicidade com o commit; publishers concorrentes |
| Auth | Ponto de extensão no núcleo; Keycloak como último item opcional | Vale 0 pontos; não pode competir com o núcleo |
| Workflow | Superpowers (brainstorming → spec → plano → TDD) + constitution | TDD embutido; regras invioláveis explícitas |

Achados do spike (Bun 1.4.4 + Nest 12.4 + MikroORM 7.2 + Postgres 17, 4/4 testes e `tsc` strict OK):

- `emitDecoratorMetadata` funciona no Bun (DI do Nest por tipo).
- MikroORM 7 exporta decorators fora do core; usar `defineEntity` + `setClass`.
- `MikroOrmModule.forRoot` precisa de `driver: PostgreSqlDriver` explícito para injetar o `EntityManager`.
- Custom type `numeric(20,2)` ↔ `string` funciona; o driver devolve string.
- API de schema é `orm.schema.create()/drop()`; o projeto usa `@mikro-orm/migrations`.
- Bun não faz type-check: script `typecheck` com `tsc --noEmit` é obrigatório.

## 3. Arquitetura

### 3.1 Estrutura

```
src/
  domain/                 # TS puro; não importa framework nem infra
    shared/               DomainError, FailureCode, Clock/Id types
    money/                Money
    wallet/               Wallet (AR), WalletLedgerEntry, LedgerDirection
    wagering/             WagerTransaction, Kind, Status, WagerSettlement (serviço de domínio)
    messaging/            InboxMessage, OutboxMessage, backoff
    events/               IntegrationEvent (abstrata) + 4 subclasses
  application/
    ports/                WalletRepository, WagerTransactionRepository, LedgerRepository,
                          InboxRepository, OutboxRepository, UnitOfWork, Clock, IdGenerator,
                          EventPublisher, ProviderIdentityPort, Metrics, FaultInjector
    use-cases/            OpenWallet, SubmitWagerTransaction, RetryPendingReferences,
                          PublishOutbox, ReconcileWallet, GetWallet, ListLedger,
                          GetTransaction, GetTransactionByExternalId
    hashing/              canonicalJson, payloadHash
  infrastructure/
    persistence/          schemas defineEntity, MoneyAmountType, mappers, repositórios,
                          MikroOrmUnitOfWork, migrations/
    sqs/                  client, consumer loop, publisher
    observability/        logger (pino), metrics (prom-client), health indicators
    auth/                 NoopAuthGuard (+ KeycloakJwtGuard opcional)
    config/               validação de env
  interfaces/
    http/                 controllers, DTOs, ProblemDetails filter
    sqs/                  WagerTransactionConsumer
    workers/              OutboxPublisherWorker, PendingReferenceWorker
  main.api.ts  main.consumer.ts  main.workers.ts
test/
  unit/  integration/  concurrency/  e2e/  load/  support/
```

Regra de dependência: `interfaces → application → domain`; `infrastructure` implementa `application/ports`; `domain` não depende de ninguém.

### 3.2 Serviços (Docker Compose)

| Serviço | Papel | Escala nos testes |
|---|---|---|
| `postgres` | PostgreSQL 17 | 1 |
| `localstack` | SQS; init script cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive `maxReceiveCount=5`), `wallet-events.fifo` | 1 |
| `migrate` | Roda migrations e sai; os demais dependem dele | 1 |
| `api` | HTTP | 1–3 |
| `consumer` | Consome `wager-transactions.fifo` | 3 |
| `workers` | Outbox publisher + PendingReference worker | 2 |

Todos os serviços de aplicação expõem `/health/live`, `/health/ready` e `/metrics` (consumer e workers via servidor HTTP mínimo).

### 3.3 Fronteira transacional

`UnitOfWork.run(fn)` encapsula `em.fork().transactional()` com `SET LOCAL lock_timeout = '5s'` e `statement_timeout`. Todo efeito financeiro (transação, wallet, ledger, inbox, outbox) acontece dentro de um `run`. Nenhum adapter de SQS é chamado dentro de um `run`, exceto o outbox publisher (ver §6.5).

## 4. Domínio

### 4.1 Money

- Estado: `bigint` em unidades mínimas + `currency` (3 letras maiúsculas, ISO-4217). Escala fixa 2 para todas as moedas (limitação documentada).
- `Money.from({ amount, currency })` aceita somente `^(0|[1-9]\d{0,17})\.\d{2}$` — exatamente 2 casas, sem sinal, sem notação científica, sem zeros à esquerda, até 18 dígitos inteiros (cabe em `numeric(20,2)`). Rejeita `NaN`, `Infinity`, `""`, `"1e3"`, `"1.5"`, `"1.234"`, `"-1.00"`.
- `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON` (→ `MoneyProps`), `toString` (`"25.00 BRL"`). Operações com moedas diferentes lançam `CurrencyMismatchError`.
- Resultado negativo só existe internamente (ex.: `negate`); contratos de entrada nunca o aceitam.

### 4.2 Wallet (aggregate root)

- `Wallet.open({ id, playerId, initialBalance, now })` → `version = 1`; se `initialBalance > 0`, retorna também o lançamento `CREDIT` de abertura (vinculado à transação `OPENING`).
- `debit(money, transactionId, now)` / `credit(...)` → validam moeda, aplicam a mudança, incrementam `version` e **retornam o `WalletLedgerEntry`** com `balanceBefore`, `balanceAfter` e `walletVersion = version` nova. Saldo e ledger nascem juntos; não há como alterar saldo sem obter o lançamento.
- `debit` que deixaria saldo negativo lança `InsufficientFundsError`; o chamador traduz para o `failureCode` adequado (`INSUFFICIENT_FUNDS` para BET, `REVERSAL_INSUFFICIENT_FUNDS` para reversões).
- `rehydrate(state)` reconstrói sem validar.

### 4.3 WalletLedgerEntry

- Imutável estruturalmente (somente `readonly`, sem métodos de transição).
- `create` valida `balanceBefore ± money === balanceAfter`, `money > 0`, moedas iguais. Campo adicional `walletVersion` (posição na cadeia; também é o cursor de paginação).

### 4.4 WagerTransaction

Transições válidas:

| De | Para | Método |
|---|---|---|
| (criação) | `PENDING` | `create` (valida referência obrigatória para `REFUND`/`ROLLBACK`; recusa `OPENING` vindo de fora — `createOpening` é a única forma interna) |
| `PENDING` | `PROCESSED` | `markProcessed(referenceTransactionId?, observedBalance, at)` |
| `PENDING` | `REJECTED` | `reject(code, observedBalance, at)` |
| `PENDING` | `PENDING_REFERENCE` | `markPendingReference(nextAttemptAt)` |
| `PENDING` | `FAILED` | `fail(code, at)` |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | `scheduleReferenceRetry(now)` (incrementa `attempts`, recalcula `nextAttemptAt`) |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` / `FAILED` | mesmos métodos acima |
| terminal | — | qualquer chamada lança `InvalidTransactionStateError` |

Consultas: `isTerminal`, `affectsBalance` (false para `LOSS`), `requiresReference` (`REFUND`, `ROLLBACK`), `matchesPayload(hash)`, `ledgerDirectionFor(reference?)`.

`observedBalance` é o saldo da wallet no momento da decisão, gravado também em rejeições, para que o replay devolva o resultado original.

### 4.5 WagerSettlement (serviço de domínio)

Função pura usada pelo submit e pelo worker de pendências:

```
settle(tx, wallet, reference | undefined | 'MISSING', alreadyReversed: boolean, now)
  → { outcome: PROCESSED | REJECTED | PENDING_REFERENCE, ledgerEntry?, failureCode? }
```

Regras:

| Kind | Efeito | Validações |
|---|---|---|
| `BET` | `debit` | saldo suficiente, senão `INSUFFICIENT_FUNDS` |
| `WIN` | `credit` | se referência informada: precisa existir e ser `BET` da mesma rodada |
| `LOSS` | nenhum (sem ledger) | se referência informada: idem `WIN` |
| `REFUND` | `credit` | referência é `BET` `PROCESSED` |
| `ROLLBACK` | inverso da referência | referência é `BET`, `WIN` ou `REFUND` `PROCESSED`; débito que deixaria saldo negativo → `REVERSAL_INSUFFICIENT_FUNDS` |

Validações de referência, em ordem (primeira que falha decide):

1. Referência não encontrada → `PENDING_REFERENCE`.
2. Referência em `PENDING`/`PENDING_REFERENCE` → `PENDING_REFERENCE`.
3. Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_REVERSIBLE`.
4. Provider, player, wallet, moeda ou rodada diferentes → `REFERENCE_MISMATCH`.
5. Kind da referência não permitido → `REFERENCE_KIND_NOT_ALLOWED`.
6. Valor diferente → `REFERENCE_AMOUNT_MISMATCH`.
7. Já revertida (qualquer `REFUND`/`ROLLBACK` `PROCESSED` apontando para ela) → `REFERENCE_ALREADY_REVERSED`.

Antes das regras por kind: `PLAYER_WALLET_MISMATCH` (player do payload ≠ dono da wallet) e `CURRENCY_MISMATCH` (moeda ≠ moeda da wallet).

### 4.6 Inbox, Outbox e eventos

- `InboxMessage`: chave `(consumerName, messageId)`, `payloadHash`, `receivedAt`, `processedAt`. Gravada já processada dentro da transação financeira.
- `OutboxMessage`: `id = eventId`, `aggregateId`, `eventType`, `payload` (envelope `toJSON()`), `occurredAt`, `attempts`, `nextAttemptAt`, `publishedAt`. `scheduleRetry(now)`: `attempts++`, `nextAttemptAt = now + min(1s · 2^attempts, 5min) + jitter`. Sem limite de tentativas.
- `IntegrationEvent<T>` abstrata conforme README §11; subclasses com `eventType` e `version` no tipo:
  - `WagerTransactionProcessed` (inclusive `LOSS`)
  - `WagerTransactionRejected`
  - `WalletBalanceChanged` (somente quando o saldo muda; inclui `walletVersion`)
  - `WagerTransactionPendingReference`
- `data` carrega `MoneyProps`, nunca `Money`. `correlationId` = `messageId` (SQS) ou `x-request-id` (HTTP, gerado se ausente); `causationId` = `transactionId`.

## 5. Schema (PostgreSQL)

Dinheiro sempre em `amount numeric(20,2)` + `currency char(3) CHECK (currency ~ '^[A-Z]{3}$')`. Migrations MikroORM com `up` e `down`; triggers e índices parciais em SQL explícito.

### 5.1 `wallets`

- `id uuid PK`, `player_id uuid`, `currency`, `balance numeric(20,2) CHECK (balance >= 0)`, `version int CHECK (version >= 1)`, `created_at`, `updated_at`.
- `UNIQUE (player_id, currency)`.
- Trigger `BEFORE UPDATE`: `NEW.version = OLD.version + 1` se e somente se `NEW.balance <> OLD.balance`; caso contrário `version`, `balance` inalterados. `id`, `player_id`, `currency`, `created_at` imutáveis.
- Constraint trigger `AFTER INSERT OR UPDATE … DEFERRABLE INITIALLY DEFERRED`: se o saldo mudou (ou wallet inserida com saldo > 0), exige lançamento com `wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance`.

### 5.2 `wallet_ledger_entries`

- `id uuid PK`, `wallet_id FK`, `transaction_id FK`, `direction CHECK IN ('DEBIT','CREDIT')`, `amount CHECK (amount > 0)`, `currency`, `balance_before`, `balance_after CHECK (balance_after >= 0)`, `wallet_version int`, `created_at`.
- `CHECK ((direction='DEBIT' AND balance_after = balance_before - amount) OR (direction='CREDIT' AND balance_after = balance_before + amount))`.
- `UNIQUE (wallet_id, transaction_id)` e `UNIQUE (wallet_id, wallet_version)`.
- Trigger `BEFORE INSERT`: o lançamento anterior da cadeia (`wallet_version - 1`), se existir, tem `balance_after = NEW.balance_before`; se não existir, `NEW.balance_before = 0`.
- Triggers que rejeitam `UPDATE`, `DELETE` e `TRUNCATE`.
- A cadeia começa em `wallet_version = 1` (wallet aberta com saldo > 0, lançamento `OPENING`) ou `2` (aberta com saldo zero; primeiro lançamento é o primeiro crédito) e é contínua a partir daí.

### 5.3 `wager_transactions`

- `id uuid PK`, `provider_id text`, `external_transaction_id text`, `idempotency_key text`, `payload_hash char(64)`, `wallet_id FK`, `player_id uuid`, `round_id text NULL`, `game_id text NULL`, `kind`, `amount`, `currency`, `reference_external_transaction_id text NULL`, `reference_transaction_id uuid NULL FK self`, `status`, `failure_code text NULL`, `observed_balance numeric(20,2) NULL`, `attempts int DEFAULT 0`, `next_attempt_at timestamptz NULL`, `processed_at timestamptz NULL`, `created_at`, `updated_at`.
- `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`.
- `CHECK`s: `kind` e `status` em seus enums; `amount > 0`; `kind IN ('REFUND','ROLLBACK') → reference_external_transaction_id IS NOT NULL`; `kind <> 'OPENING' → round_id, game_id NOT NULL`; `status IN ('REJECTED','FAILED') → failure_code IS NOT NULL`; `status = 'PROCESSED' → processed_at IS NOT NULL`; `status = 'PENDING_REFERENCE' → next_attempt_at IS NOT NULL`.
- Reversão única: `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
- Trigger `BEFORE UPDATE`: linha com status terminal não muda; campos de negócio (`provider_id` … `reference_external_transaction_id`, `idempotency_key`, `payload_hash`, `created_at`) nunca mudam.
- Índices: `(wallet_id)`, `(provider_id, reference_external_transaction_id)`, parcial `(next_attempt_at) WHERE status = 'PENDING_REFERENCE'`.

### 5.4 `inbox_messages`

`PRIMARY KEY (consumer_name, message_id)`, `payload_hash char(64)`, `received_at`, `processed_at`.

### 5.5 `outbox_messages`

`id uuid PK` (= `eventId`), `aggregate_id`, `event_type`, `payload jsonb`, `occurred_at`, `attempts int DEFAULT 0`, `next_attempt_at timestamptz`, `published_at NULL`. Índice parcial `(next_attempt_at) WHERE published_at IS NULL`. Trigger impede alterar `payload`, `event_type`, `aggregate_id`, `occurred_at` e "despublicar".

## 6. Fluxos

### 6.1 `SubmitWagerTransaction`

Entrada: comando de negócio + origem (`http` ou `sqs { consumerName, messageId, messagePayloadHash }`) + `correlationId`.

Fora da transação: validação do DTO (inclui `money > 0` → senão 400 `INVALID_PAYLOAD`; `0.00` é `Money` válido, mas não é valor de transação), `kind ≠ OPENING`, `payloadHash = sha256(canonicalJson(campos de negócio))`. Canonical JSON: chaves ordenadas recursivamente, sem espaços, `money` como `{amount, currency}`, `referenceExternalTransactionId` omitido quando ausente. Campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`. Fora do hash: idempotency key, `messageId`, `correlationId`, `occurredAt`.

Dentro de `UnitOfWork.run`:

1. `SELECT wallet FOR UPDATE`. Inexistente → `WALLET_NOT_FOUND` sem persistir.
2. Se SQS: busca inbox `(consumer, messageId)`. Existe com mesmo hash → conta duplicata (`type=inbox`) e segue para o passo 3, que devolve o replay. Hash diferente → erro permanente. O `payloadHash` da inbox é o mesmo hash de negócio.
3. Busca por `idempotency_key`. Existe: mesmo `payloadHash` → replay (resultado original, `idempotentReplay: true`; se SQS e a inbox ainda não tem a mensagem — ex.: chegou antes via HTTP — grava a inbox antes do commit); diferente → `IDEMPOTENCY_KEY_REUSED`. Busca por `(provider_id, external_transaction_id)` com outra key → `EXTERNAL_ID_CONFLICT`.
4. `WagerTransaction.create` (`PENDING`); carrega referência por `(provider_id, reference_external_transaction_id)` e se já foi revertida; `WagerSettlement.settle`.
5. Persiste transação (status final + `observed_balance`), lançamento e wallet (se saldo mudou), eventos na outbox, inbox (se SQS).
6. Se a transação pode ser referência: `UPDATE wager_transactions SET next_attempt_at = now() WHERE status='PENDING_REFERENCE' AND provider_id = $1 AND reference_external_transaction_id = $2`.
7. Commit; só então resposta HTTP ou `ack`.

Violação de índice único inesperada (ex.: mesma key com `walletId` diferente → wallets diferentes travadas): rollback e **uma** nova execução completa; na segunda, o passo 3 resolve como replay ou conflito.

### 6.2 `OpenWallet`

Numa transação: insere wallet `version 1`; se saldo inicial > 0, insere transação `OPENING` (`provider_id='internal'`, `external_transaction_id = walletId`, `idempotency_key = 'opening:' + walletId`, `PROCESSED`), lançamento `CREDIT` (`wallet_version 1`) e `WalletBalanceChanged` na outbox. `UNIQUE (player_id, currency)` violado → `WALLET_ALREADY_EXISTS`.

### 6.3 Consumer SQS

- Long polling (`WaitTimeSeconds=20`, até 10 mensagens, `VisibilityTimeout=30s`), lê `ApproximateReceiveCount`.
- Produtores usam `MessageGroupId = walletId`, `MessageDeduplicationId = messageId` (otimização).
- Classificação:
  - resultado de negócio (inclui replay e `PENDING_REFERENCE`) → `DeleteMessage`;
  - permanente (JSON inválido, payload inválido, `OPENING`, `WALLET_NOT_FOUND`, conflitos de idempotência, mesmo `messageId` com hash diferente) → `SendMessage` para a DLQ com atributo `reason` → `DeleteMessage`;
  - transitório (conexão, timeout, `lock_timeout`, banco indisponível) → sem ack; `ChangeMessageVisibility` com backoff exponencial + jitter por `receiveCount`; após `maxReceiveCount=5` a redrive policy move para a DLQ;
  - erro inesperado após validação → grava `FAILED` (`INTERNAL_PROCESSING_ERROR`) em transação separada quando possível (essa transação também trava a wallet primeiro) → DLQ → `DeleteMessage`.
- `SIGTERM`: para de receber, aguarda mensagens em voo até 20s; as restantes recebem `ChangeMessageVisibility(0)`.
- Crash entre commit e ack: redelivery → inbox existente → replay → ack.

### 6.4 Worker de `PENDING_REFERENCE`

1. Seleciona candidatos (`status='PENDING_REFERENCE' AND next_attempt_at <= now()`, ordenados, lote 20) **sem lock**.
2. Para cada candidato, transação própria: `SELECT wallet FOR UPDATE` → `SELECT transação FOR UPDATE` → se ainda pendente e vencida, `WagerSettlement.settle`.
3. Referência ainda ausente: `scheduleReferenceRetry` (base 2s, ×2, teto 60s, jitter). Esgotado (10 tentativas **ou** 15 min desde `created_at`, configuráveis) → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

Justificativa do limite: entregas fora de ordem tendem a se resolver em segundos; 15 min limita o tempo de uma pendência e, com o "nudge" do §6.1 passo 6, o caso comum resolve quase imediatamente.

### 6.5 Outbox publisher

Laço (intervalo ~250ms quando vazio): transação → `SELECT … FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED` → `SendMessageBatch` para `wallet-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) → `markPublished` ou `scheduleRetry` por mensagem → commit.

- Publishers concorrentes pegam lotes disjuntos. Processo morto: locks liberados, outra instância publica.
- Duplicata (morte após send, antes do commit) é segura: consumidor deduplica por `eventId`.
- Ordem entre publishers não é garantida; `walletVersion` no payload permite ordenar.
- Trade-off documentado: o lock fica aberto durante a chamada ao SQS (simples, curto, com `statement_timeout`); alternativa seria lease com `claimed_until`.

### 6.6 Reconciliação e consultas

- `POST /wallets/:id/reconciliation`: lê wallet e soma o ledger (`Σ créditos − Σ débitos`) numa transação `REPEATABLE READ`, compara, retorna o contrato do README. Divergência → log `error`, `reconciliation_mismatches_total++`, `consistent: false`; nada é corrigido.
- `GET /wallets/:id/ledger?cursor&limit` (limit padrão 50, máx 200): ordem crescente por `wallet_version`; cursor = base64url de `{"v": <último wallet_version>}`; cursor inválido → 400.
- `GET /wallets/:id`, `GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalId`.

## 7. Erros e HTTP

Erros em `application/problem+json` (RFC 9457) com `type`, `title`, `status`, `code`, `retryable`, `correlationId`.

| Situação | HTTP | Persistido | `retryable` |
|---|---|---|---|
| `PROCESSED` | 200 | sim | — |
| `PENDING_REFERENCE` | 202 | sim | — |
| `REJECTED` (corpo: `transactionId`, `status`, `failureCode`, `balance`) | 422 | sim | false |
| `INVALID_PAYLOAD`, `MISSING_IDEMPOTENCY_KEY` | 400 | não | false |
| `WALLET_NOT_FOUND` (corpo) | 422 | não | false |
| `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT` | 409 | não | false |
| `SERVICE_UNAVAILABLE` (banco/SQS fora, `lock_timeout`) | 503 + `Retry-After` | não | true |
| `INTERNAL_ERROR` sem `FAILED` gravado | 500 | não | true (replay protege) |
| `INTERNAL_ERROR` com `FAILED` gravado (replays também) | 500 | sim | false (terminal, exige investigação) |

- Replay: mesmo status e corpo, `idempotentReplay: true`, header `Idempotent-Replayed: true`.
- `POST /wallets`: 201; duplicada 409 `WALLET_ALREADY_EXISTS`.
- `GET` inexistente: 404 `NOT_FOUND`. Cursor inválido: 400 `INVALID_CURSOR`. Reconciliação: sempre 200.
- Auth (quando houver): 401 sem token; 403 `PROVIDER_MISMATCH`.

`failureCode` (transações `REJECTED`/`FAILED`): `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_NOT_REVERSIBLE`, `INTERNAL_PROCESSING_ERROR`.

Implementação: domínio lança `DomainError` com `code`; o use case converte em resultado `REJECTED`; adapters convertem erros de infra em `TransientInfraError`/`PermanentInfraError`; um `ExceptionFilter` faz o mapeamento HTTP; o consumer usa a mesma classificação.

## 8. Observabilidade

- **Logs:** pino JSON; campos `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `durationMs`. Sem valores, saldos, payloads completos nem headers de auth (redaction configurada).
- **Métricas** (prom-client, `/metrics` em cada serviço):
  - `wagering_transactions_total{status,kind,source}`
  - `wagering_duplicates_total{source,type=replay|inbox}`
  - `wagering_retries_total{component}`
  - `sqs_dlq_messages_total{reason}`
  - `db_lock_conflicts_total` (lock timeout / unique violation retry)
  - `outbox_lag_seconds` (gauge: `now − min(occurred_at)` não publicados), `outbox_pending` (gauge)
  - `wagering_processing_duration_seconds{source}` (histograma)
  - `pending_reference_transactions` (gauge)
  - `reconciliation_mismatches_total`
- **Health:** `/health/live` (processo), `/health/ready` (`SELECT 1` + `GetQueueAttributes`), sem auth.

## 9. Autenticação

Núcleo: `NoopAuthGuard` global (exceto health/metrics) e `ProviderIdentityPort` que devolve a identidade do chamador; o submit valida `providerId` do payload contra ela (no-op aceita tudo). Mensagens SQS: canal interno, mas `providerId` continua sujeito às validações de domínio.

Opcional (último item): Keycloak no Compose com realm importado, um client `confidential` por provedor (client credentials), `KeycloakJwtGuard` validando assinatura via JWKS, `iss`, `aud` e mapeando `azp` → `providerId`; divergência → 403 `PROVIDER_MISMATCH`.

## 10. Testes

TDD em toda tarefa: teste falhando → implementação mínima → refactor.

### 10.1 Camadas e scripts

```
bun run test       → typecheck → test:unit → test:integration → test:concurrency → test:e2e
bun run test:load  → separado
```

- **Unidade:** sem IO; `Clock` fixo, jitter desligado. Money (formatos válidos/inválidos, aritmética, moeda), Wallet (version, saldo, lançamento), WagerTransaction (transições), WagerSettlement (cada regra e `failureCode`), WalletLedgerEntry, canonical JSON/hash, eventos, backoff.
- **Integração:** Postgres + LocalStack reais (`compose.test.yml`). Isolamento por arquivo: `CREATE DATABASE … TEMPLATE` de um banco migrado; filas com prefixo aleatório. Cobre: migrations `up → down → up`; cada constraint/trigger via SQL direto; atomicidade com `FaultInjector` em pontos nomeados; inbox/redelivery; retry e DLQ com redrive real; publishers concorrentes; recuperação após reinício.
- **Concorrência (paralelismo real):**

| # | Cenário | Execução |
|---|---|---|
| 1 | Mesma BET 50× em paralelo → 1 débito | 50 HTTP paralelos contra `api` real |
| 2 | 100 − 80 − 80 → 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, 1 débito | in-process, conexões distintas |
| 3 | Wallets distintas em paralelo | N wallets × M apostas; tempo total demonstra ausência de serialização global |
| 4 | ≥ 3 instâncias | `Bun.spawn` de 3 `consumer` + 3 `api` reais |
| 5 | Morte após commit, antes do ack | `FAULT=crash_after_commit` → `process.exit`; novo consumer; visibility curta |
| 6 | Dois publishers na mesma outbox | 2 processos `workers`; todo `eventId` publicado ≥ 1 vez |
| 7 | ROLLBACK/REFUND antes da referência | via SQS → `PENDING_REFERENCE` → referência chega → resolvido |
| 8 | Reinício | `SIGKILL` em tudo durante carga → restart → drenar → reconciliar todas |

- **E2E:** stack completa via `docker compose up --build` (`api`, `consumer=3`, `workers=2`, imagem do `Dockerfile` real); interação só por HTTP e SQS. Cenários: jornada HTTP completa com paginação e reconciliação; idempotência (replay, 409, 400); jornada SQS com leitura de `wallet-events.fifo` validando envelope; fora de ordem via SQS; mensagem inválida na DLQ com motivo; health (ready cai a 503 com Postgres parado e volta); rajada com 3 consumers terminando reconciliada.
- **Invariante final:** `assertLedgerConsistency()` em `afterEach`/`afterAll` de integração, concorrência e E2E (via reconciliação no E2E): `balance = Σ créditos − Σ débitos = balance_after do último lançamento`, cadeia de `wallet_version` contínua (início em 1 ou 2, ver §5.2), outbox vazia após drenar.
- **Determinismo:** `eventually(fn, timeout)` em vez de `sleep`.

### 10.2 Carga (`bun run test:load`)

- k6 via Docker (`k6-jslib-aws` para SQS). Compose de carga com `cpus`/`mem_limit` fixos.
- Cenários: (1) distribuído — 1.000 wallets, mix BET/WIN/LOSS, rampa até saturar; (2) hot wallet — 1–10 wallets; (3) 30% duplicatas; (4) drenagem de 50k mensagens com `consumer=1` vs `consumer=3`; (5) soak de 15 min (opcional).
- Coleta: k6 (RPS, p50/p95/p99, erro por status), `/metrics` antes/depois (lock conflicts, retries, DLQ, outbox lag máximo), `pg_stat_activity` (esperas de lock).
- Correção: reconciliação de todas as wallets ao fim de cada cenário; qualquer `consistent: false` falha o teste.
- Entregável: `docs/load-test-report.md` com ambiente, metodologia, resultados, gargalos, o que mudaria para escalar e limitações (LocalStack ≠ AWS).

## 11. Interpretações documentadas (irão para `ARCHITECTURE.md`)

1. Reversão única **por referência, independente do tipo**: uma transação é revertida no máximo uma vez (`REFUND` ou `ROLLBACK`). Evita crédito duplo de BET via `REFUND` + `ROLLBACK`. `ROLLBACK` de um `REFUND` continua permitido (alvo diferente).
2. `WIN`/`LOSS` com referência informada e inexistente → `PENDING_REFERENCE`, como `REFUND`/`ROLLBACK`.
3. Uma `BET` pode ter múltiplos `WIN`.
4. Referência existente ainda `PENDING`/`PENDING_REFERENCE` → a transação dependente fica `PENDING_REFERENCE`.
5. Valores de entrada exigem exatamente 2 casas decimais; não há arredondamento.
6. `WALLET_NOT_FOUND` não é persistido (FK); via HTTP é 422, via SQS vai para a DLQ.
7. Replay devolve o mesmo status HTTP da resposta original.

## 12. Fora de escopo / limitações

- Moedas com escala ≠ 2; reversão parcial; ledger de partidas dobradas; consumidor dos eventos de `wallet-events.fifo`; OpenTelemetry/dashboard.
- Ordem global de eventos entre publishers (mitigada por `walletVersion`).
- LocalStack não reproduz latência/limites reais da AWS.

## 13. Ordem de entrega (insumo para o plano)

1. Scaffold: Bun, Nest, `tsconfig` strict, `typecheck`, Compose de infra, estrutura de pastas.
2. Domínio com TDD: Money → WalletLedgerEntry → Wallet → WagerTransaction → WagerSettlement → eventos, Inbox/Outbox.
3. Persistência: schemas, `MoneyAmountType`, mappers, migrations com constraints/triggers + testes de schema.
4. Use cases `OpenWallet` e `SubmitWagerTransaction` + `UnitOfWork` + testes de atomicidade.
5. API HTTP + mapeamento de erros + consultas + reconciliação + ledger com cursor.
6. Consumer SQS + inbox + classificação de erros + DLQ + shutdown.
7. Outbox publisher.
8. Worker de `PENDING_REFERENCE`.
9. Observabilidade (logs, métricas, health) e os 3 serviços no Compose com Dockerfile.
10. Suíte de concorrência (8 cenários).
11. E2E.
12. `README.md` e `ARCHITECTURE.md`.
13. Testes de carga + relatório.
14. Keycloak (opcional).
