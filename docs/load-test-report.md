# Relatório de testes de carga

Executado em 2026-11-11 com `bun run test:load` (cenários padrão) e `bun run test:load --scenario soak --rate 295`. As rodadas oficiais estão em `test/load/results/2026-11-11T20-44-55/` e `test/load/results/2026-11-11T21-06-05/`. O diretório fica fora do git, mas cada execução regenera os mesmos arquivos (`<cenário>.json`, `<cenário>.k6.json` e `summary.md`). Antes delas, cada cenário rodou uma vez em caráter exploratório, e essas rodadas servem para estimar a variação entre execuções (seção [Variação](#variação-entre-rodadas)).

## Resumo

- **Correção: nenhuma violação.** Em todos os cenários, 100% dos checks de correção passaram, a reconciliação não encontrou nenhuma wallet inconsistente, não houve 5xx, timeout nem 4xx inesperado, e `db_lock_conflicts_total`, `wagering_retries_total` e `sqs_dlq_messages_total` ficaram em 0. Na drenagem, 2 × 50.000 mensagens viraram exatamente 100.000 transações `PROCESSED`, sem nada na DLQ.
- **Capacidade HTTP com 1.000 wallets: ~590 req/s de throughput máximo; 400 req/s com p95 ≤ 100 ms.** O gargalo é a `api`: um processo Bun usa um único event loop, que chega a ~100% de **um** núcleo, apesar do limite de 2 CPUs. O Postgres fica em ~110% dos seus 200%.
- **Hot wallet: uma wallet sozinha aguenta 200 req/s (p99 183 ms) e satura em ~333 req/s**, com p50 de 858 ms a 400 req/s pedidos. O limite é a serialização no lock da linha (`Lock:tuple` em 84% das esperas): o pool inteiro, 19 de 20 conexões, fica parado na mesma linha.
- **Duplicatas (30,3% das requisições): 6.169 reenvios, 6.169 replays contados pelo serviço e nenhum efeito duplicado.** As duplicatas simultâneas se serializam no lock da wallet (`Lock:transactionid` em 31% das esperas) e nunca chegam ao caminho de violação de unicidade.
- **Drenagem de 50.000 mensagens: 360 s com 1 consumer (139 msg/s) e 138 s com 3 consumers (361 msg/s), 2,6× mais rápido.** O limite observado é o LocalStack (processo único, CPU de pico em ~100%), cuja vazão de FIFO cai conforme a fila cresce.
- **Outbox lag máximo de 0,96 s no distribuído e de até 2,6 s nos demais cenários.** Em todos eles a outbox zerou menos de 0,3 s depois do fim da carga.
- **Soak (10 min a 295 req/s): estável.** Foram 176.993 requisições sem erro. O p50 ficou entre 3,2 e 3,6 ms em todos os minutos e o p99 entre 11 e 26 ms. A memória da `api` ficou estável (121 → 154 → 139 MiB), sem sinal de vazamento. O único crescimento contínuo foi o do LocalStack (131 → 871 MiB), que guarda os eventos de `wallet-events.fifo`, uma fila que ninguém consome neste repositório.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | MacBook Pro, Apple M1 Pro (8 núcleos: 6 de performance e 2 de eficiência), 16 GiB, macOS 27.2 |
| Docker | Docker Desktop 29.9.3. VM Linux com **4 CPUs e 5,8 GiB** (o padrão do Docker Desktop, que não foi alterado) |
| Versões | Bun 1.4.4 (imagem `oven/bun:1.4.4`), PostgreSQL 17.11 (`postgres:17-alpine`, `max_connections=300`, demais parâmetros no padrão), LocalStack 4.14.0 (`localstack/localstack:4`, só SQS), k6 v2.3.0 (`grafana/k6:2.3.0`), `k6-jslib-aws` 0.14.0 |
| Aplicação | NestJS 12 + MikroORM 7, pool de **20 conexões por processo** (`DB_POOL_MAX`), `LOG_LEVEL=info` (logs JSON no stdout, como em produção), jitter ligado |

Limites de `compose.load.yml` (cgroups, por réplica):

| Serviço | CPU | Memória |
|---|---|---|
| `postgres` | 2 | 2 GiB |
| `api` (1 réplica) | 2 | 1 GiB |
| `consumer` (1 ou 3 réplicas) | 1 | 512 MiB |
| `workers` (1 réplica) | 1 | 512 MiB |
| `localstack`, `k6` | sem limite | sem limite |

**A soma dos limites (6 CPUs, ou 8 com 3 consumers) passa das 4 CPUs da VM.** Os limites são tetos, não reservas: servem para que nenhum serviço use a VM inteira, mas os containers disputam as mesmas 4 CPUs, e o k6 roda na mesma VM. No pico do distribuído (degrau de 700 req/s), as médias foram `api` 96%, `postgres` 111%, `localstack` 33%, `workers` 29% e `k6` 26%, cerca de 295% das 400% disponíveis. A VM não estava saturada, mas a folga era pequena.

Durante as rodadas, nenhuma outra stack Docker estava ativa (a infra de teste `wagering-test` foi parada antes).

## Metodologia

**Orquestração** (`test/load/run.ts`). Cada cenário começa com uma stack nova (`docker compose -f compose.yml -f compose.load.yml up -d --wait`, com o volume do Postgres vazio) e segue estes passos:

1. Abre as wallets por `POST /wallets`, a partir do host.
2. Raspa `/metrics` da `api` (pela porta publicada) e de cada `consumer`/`workers` (com `docker exec … bun -e fetch(...)`, porque esses serviços não publicam portas). A mesma coleta se repete ao final, e os números são **deltas** somados entre processos. Antes e depois, lê também `pg_stat_database`.
3. Roda o k6 num container da rede do Compose (`docker compose run k6 run --summary-export …`), apontado para `http://api:3000` e `http://localstack:4566`.
4. Amostra, durante a carga, `pg_stat_activity` + `pg_locks` + a idade da outbox a cada 1 s (por `docker compose exec postgres psql`), e `docker stats` a cada ~3 s. No `docker stats`, 100% equivale a um núcleo.
5. Ao fim da carga, mede quanto tempo a outbox leva para zerar (`published_at IS NULL`).
6. Chama `POST /wallets/:id/reconciliation` em **todas** as wallets semeadas. Um `consistent: false` reprova o cenário, e o mesmo vale para um número de replays contados pelo serviço diferente do número de duplicatas enviadas pelo k6.
7. Grava os resultados e derruba a stack com `down -v`.

**Modelo de carga.** O k6 usa executores de *arrival rate* (modelo aberto): as iterações começam na taxa pedida, independentemente das respostas, e cada iteração é uma requisição (duas no par simultâneo do cenário de duplicatas). Quando os VUs disponíveis acabam (`maxVUs`: 300), o k6 descarta iterações (`dropped_iterations`, reportado). A partir desse ponto o teste vira, na prática, um modelo fechado com 300 requisições em voo, e a latência à direita da saturação fica limitada por esse teto, não pelo sistema.

**Tráfego.** O gerador fica em `test/load/k6/lib/payloads.js` e produz ~60% `BET` (1,00 a 20,00), ~20% `WIN` (0,50 a 40,00) e ~20% `LOSS`. Cada `WIN`/`LOSS` referencia uma `BET` que o mesmo VU já viu `PROCESSED`, na mesma rodada, então é decidido na hora. O mix não gera `PENDING_REFERENCE` de propósito, porque esse caminho já é coberto pela suíte de concorrência. Os ids são UUID v4 do k6 e cada comando tem `Idempotency-Key` própria.

**Classificação das respostas e thresholds.**

- `http.setResponseCallback(expectedStatuses(200, 202, 422))`: um 422 `INSUFFICIENT_FUNDS` é resposta de negócio, não erro. Erro é 5xx, timeout (sem status) ou 4xx inesperado. No brief, o threshold estava escrito como `http_req_failed{expected_response:true}`, mas essa submétrica tem 0% de falhas por definição. Em vez dela, o callback acima define o que é falha, e o threshold é `http_req_failed < 1%`.
- `checks{type:correctness} == 1.0` em todo cenário. Para toda resposta decidida (não 5xx), verifica: status permitido para o kind (`BET` só pode ser recusada por `INSUFFICIENT_FUNDS`; `WIN`/`LOSS` precisam dar 200), `body.status` coerente com o status HTTP, saldo no formato `^\d+\.\d{2}$` em BRL e `idempotentReplay` com o valor esperado. Nas duplicatas, verifica também: mesmo `transactionId`, mesmo status, header `Idempotent-Replayed: true` e, no par simultâneo, exatamente um original.
- No `distributed`, passar da saturação é o objetivo do cenário, então a taxa de erro (que inclui timeouts) é só reportada por degrau. Reprovam a rodada a correção e qualquer 5xx ou 4xx inesperado (`responses_5xx` e `responses_unexpected_4xx` com `count==0`). Esses dois gates foram acrescentados depois da rodada oficial, na qual os dois contadores foram 0.

**Capacidade.** O `distributed` é uma escada: 100, 200, 300, 400, 500, 600 e 700 req/s, cada degrau alcançado em 5 s e mantido por 30 s, sobre 1.000 wallets com 1.000.000,00. As requisições recebem a tag do degrau em que começaram, e cada degrau tem suas próprias métricas. A rodada exploratória foi até 800 req/s e mostrou que a saturação vinha antes, em torno de 550 req/s. Por isso a escada foi encurtada para caber em ~5 min. O brief sugeria uma rampa contínua de 50 até 800 req/s em 5 min. A escada responde à mesma pergunta e dá, além disso, percentis estáveis por patamar. O relatório usa duas definições:
- **capacidade com latência**: maior degrau com ≥ 97% da taxa-alvo, erro < 1% e p95 ≤ 100 ms (SLO arbitrário, mas explícito);
- **throughput máximo**: a maior taxa efetivamente atingida em algum degrau.

Esse critério foi **endurecido depois da rodada oficial**. O primeiro critério (≥ 95% da taxa-alvo, erro < 1% e p99 < 1 s) apontava 600 req/s, um degrau em que o p50 já era de 463 ms, ou seja, pura fila. O critério novo exige ≥ 97% da taxa-alvo e p95 ≤ 100 ms. Aplicado aos mesmos dados, ele dá os 400 req/s citados neste relatório: no degrau de 500, a vazão foi 96% da pedida e o p95 chegou a 689 ms. O `summary.md` e o `distributed.json` da rodada oficial foram regenerados com o critério novo, sem rodar carga de novo, por `bun test/load/rerender.ts test/load/results/2026-11-11T20-44-55`. Esse script recalcula a capacidade a partir das fatias salvas e reescreve o resumo.

**Cenários e durações.**

| Cenário | Carga | Wallets (saldo inicial) | Duração |
|---|---|---|---|
| `distributed` | escada de 100 a 700 req/s | 1.000 (1.000.000,00) | 245 s |
| `hot-wallet` | `hot10`: 200 req/s em 10 wallets; `hot1`: 200 req/s numa wallet; `hot1high`: 400 req/s nessa mesma wallet | 11 (1.000,00, para que `INSUFFICIENT_FUNDS` também aconteça sob contenção) | 90 + 90 + 60 s |
| `duplicates` | 150 iterações/s: 20% reenviam depois um comando já respondido, 15% enviam um comando novo duas vezes ao mesmo tempo (`http.batch`), o resto é comando novo. Resultado: 30,3% das requisições são duplicatas | 1.000 (1.000.000,00) | 120 s |
| `sqs-drain` | 50.000 mensagens (envelope README §10, grupo = `walletId`) enfileiradas com `SendMessageBatch` (k6 + `k6-jslib-aws`) com os consumers parados; depois sobem N consumers, e o tempo é medido até `ApproximateNumberOfMessages + NotVisible = 0`, com amostragem de 1 s. Rodadas com N = 1 e N = 3, recriando os consumers entre elas | 1.000 (1.000.000,00) | ~10 min no total |
| `soak` | 295 req/s, cerca de 50% do throughput máximo medido | 1.000 (1.000.000,00) | **10 min** (o plano previa 15; o tempo foi reduzido para manter a execução prática) |

`hot1high` não estava no brief. Foi acrescentado para medir o teto de uma única wallet numa taxa (400 req/s) que o sistema sustenta com folga quando a carga está distribuída.

## Resultados

### Visão geral (rodadas oficiais)

| Cenário | RPS sustentado | p50 / p95 / p99 (ms) | Erros por status | `db_lock_conflicts_total` Δ | `wagering_retries_total` Δ | Outbox lag máx | Reconciliação |
|---|---|---|---|---|---|---|---|
| distributed, degrau de 400 | 399,4 | 5,1 / 67,3 / 252,7 | 0 (5xx 0, 4xx inesperado 0, timeout 0) | 0 | 0 | 0,38 s | 1.000/1.000 ok |
| distributed, throughput máximo (degrau de 700) | 589,6 | 488 / 618 / 713 | 0 | 0 | 0 | 0,96 s | (mesma rodada) |
| hot-wallet `hot10` (10 wallets) | 200,0 | 4,0 / 21,6 / 106,0 | 0 (422 de negócio: 20.977 no cenário) | 0 | 0 | 2,0 s (cenário) | 11/11 ok |
| hot-wallet `hot1` (1 wallet) | 199,8 | 3,6 / 39,3 / 182,6 | 0 | 0 | 0 | | |
| hot-wallet `hot1high` (1 wallet, 400 pedidos) | **332,6** | 858 / 1.166 / 1.759 | 0 (~4.050 iterações descartadas pelo k6) | 0 | 0 | | |
| duplicates | 169,7 req/s (150 it/s) | 4,2 / 10,2 / 267,5 | 0 | 0 | 0 | 2,6 s | 1.000/1.000 ok |
| sqs-drain, consumer=1 | 138,9 msg/s | processamento 3,7 / 9,6 / 21,0 | DLQ 0 | 0 | 0 | 0,5 s | 1.000/1.000 ok |
| sqs-drain, consumer=3 | 361,4 msg/s | processamento 4,1 / 9,8 / 21,6 | DLQ 0 | 0 | 0 | 0,8 s | (mesma rodada) |
| soak (10 min) | 295,0 | 3,4 / 7,7 / 17,3 | 0 | 0 | 0 | 0,58 s | 1.000/1.000 ok |

As latências HTTP são as do k6 (cliente). Na drenagem, são as do histograma `wagering_processing_duration_seconds{source="sqs"}`, estimadas pelos buckets padrão do prom-client, por isso grosseiras. O outbox lag máximo é a maior idade da mensagem mais antiga não publicada nas amostras de 1 s (`now() - min(occurred_at)`). O gauge `outbox_lag_seconds` dos workers só guarda o último valor e não serve para máximos.

### Distribuído (escada, 1.000 wallets)

| Degrau (req/s) | Atingido (req/s) | p50 | p95 | p99 | máx (ms) | Erro | CPU `api` | CPU `postgres` | Conexões *idle in transaction* (média) |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 100,0 | 3,6 | 6,4 | 10,0 | 56 | 0% | 28% | 19% | 0,3 |
| 200 | 200,0 | 3,2 | 6,8 | 12,5 | 59 | 0% | 40% | 31% | 1,0 |
| 300 | 300,0 | 3,9 | 13,4 | 139,1 | 196 | 0% | 58% | 53% | 2,3 |
| 400 | 399,4 | 5,1 | 67,3 | 252,7 | 336 | 0% | 75% | 74% | 5,5 |
| 500 | 481,9 | 18,7 | 688,7 | 863,5 | 927 | 0% | 90% | 98% | 12,0 |
| 600 | 574,3 | 463,3 | 594,3 | 693,0 | 741 | 0% | 97% | 111% | 17,7 |
| 700 | 589,6 | 488,3 | 617,9 | 713,2 | 822 | 0% | 96% | 111% | 17,6 |

91.628 requisições, todas 200. Houve 4.871 iterações descartadas, quase todas (≥ 4.600) nos degraus de 500 a 700, quando os 300 VUs estavam ocupados. Do lado do serviço, `wagering_transactions_total` registrou `PROCESSED` +91.628 e `pg_stat_database` +104.973 commits, com 0 rollbacks e 0 deadlocks. A outbox zerou 0,13 s depois do fim da carga.

Leitura: até 400 req/s a mediana fica em ~5 ms. A cauda (p99) começa a crescer já em 300, o que é o primeiro sinal de fila. Em 500 req/s a `api` chega a 90% de um núcleo e o p95 salta para 689 ms. De 600 em diante o throughput estabiliza em ~575 a 590 req/s, e a latência passa a ser só tempo de fila: com 300 requisições em voo e ~590 req/s, a lei de Little dá ~0,5 s, que é exatamente o p50 observado. **Capacidade com latência: 400 req/s. Throughput máximo: ~590 req/s.**

### Hot wallet

| Fase | Pedido | Atingido | p50 | p95 | p99 | máx (ms) | Locks não concedidos (média / máx) | Backends ativos (média) | CPU `api` / `postgres` |
|---|---|---|---|---|---|---|---|---|---|
| `hot10`: 10 wallets | 200 | 200,0 | 4,0 | 21,6 | 106,0 | 299 | 0,1 / 4 | 0,6 | 50% / 38% |
| `hot1`: 1 wallet | 200 | 199,8 | 3,6 | 39,3 | 182,6 | 462 | 2,1 / 19 | 2,5 | 42% / 37% |
| `hot1high`: 1 wallet | 400 | **332,6** | 858 | 1.166 | 1.759 | 2.013 | **18,5 / 19** | 19,0 | 60% / 55% |

No cenário inteiro: 55.936 requisições, 34.959 com 200, 20.977 com 422 `INSUFFICIENT_FUNDS` (as wallets começam com 1.000,00 e o mix as esvazia) e 0 erros. Nas esperas dos backends ativos, `Lock:tuple` aparece em 84,1% e `Lock:transactionid` em 8,3%. As 11 wallets reconciliaram.

Leitura: a 200 req/s, concentrar tudo numa wallet custa pouco na mediana, mas já engorda a cauda (p99 de 106 ms para 183 ms). Pedindo 400 req/s, a wallet entrega no máximo **~333 tx/s**, ou seja, ~3 ms de lock por transação: `SELECT … FOR UPDATE`, inserts do ledger, da transação e da outbox, `UPDATE` do saldo e commit com fsync. O resto vira fila. A CPU da `api` fica em 60%, então o limite não é processamento. É a serialização, que é correta e intencional (constituição: lock da wallet primeiro). Na mesma taxa de 400 req/s, a carga distribuída tem p50 de 5 ms.

### Duplicatas

| Fatia | Requisições | p50 | p95 | p99 | máx (ms) |
|---|---|---|---|---|---|
| Comandos novos | 11.549 | 4,2 | 10,0 | 269,3 | 2.246 |
| Reenvio sequencial (replay) | 3.515 | **2,0** | 4,8 | 182,6 | 2.184 |
| Par simultâneo (2 requisições) | 5.308 | 4,9 | 12,8 | 296,8 | 2.366 |

- Duplicatas enviadas pelo k6: 6.169 de 20.372 requisições (30,3%). O serviço contou `wagering_duplicates_total{type="replay"}` +6.169, **exatamente o mesmo número**, e `wagering_transactions_total{PROCESSED}` +14.203, que são os comandos únicos. Todos os replays devolveram o mesmo `transactionId` e o mesmo status. Em todos os pares, exatamente um veio com `idempotentReplay: false`.
- `db_lock_conflicts_total` ficou em 0 e `xact_rollback` também. A duplicata simultânea não entra na corrida de unicidade porque trava a wallet antes: espera o commit do original (`Lock:transactionid` em 31,5% das esperas ativas) e depois o encontra como replay. Ou seja, o caminho `runOnceMore` (violação de unicidade seguida de nova execução) não é exercitado por duplicatas na mesma wallet, e isso é o esperado.
- O replay é mais barato que o comando original (p50 de 2,0 ms contra 4,2 ms), porque não grava nada.
- O máximo de ~2,3 s e as 282 iterações descartadas vêm de **uma parada de ~2 s perto do fim** (t ≈ 117 s). Nas amostras desse instante, 16 conexões estavam *idle in transaction* (a `api` não estava respondendo ao Postgres) e o outbox lag subiu para 2,6 s (os `workers` também pararam). Dois processos independentes parando ao mesmo tempo apontam para a VM ou o host, não para o código, mas **a causa não foi diagnosticada**. Na rodada exploratória do mesmo cenário, o máximo foi 111 ms e o p99 22 ms.

### Drenagem SQS (50.000 mensagens)

| | consumer=1 | consumer=3 |
|---|---|---|
| Enfileiramento (k6, 20 VUs, `SendMessageBatch` de 10) | 50.000 em 9,9 s | 50.000 em 8,1 s |
| Partida dos consumers até a 1ª mensagem sair | 1,0 s | 1,0 s |
| **Tempo de drenagem** (1ª mensagem até a fila vazia) | **359,9 s** | **138,3 s** |
| Vazão média | 138,9 msg/s | 361,4 msg/s (2,6×) |
| Vazão por faixa de profundidade (50k→40k / 30k→20k / 10k→0) | 122 / 126 / 197 msg/s | 331 / 382 / 338 msg/s |
| Processamento por mensagem (p50 / p95 / p99) | 3,7 / 9,6 / 21,0 ms | 4,1 / 9,8 / 21,6 ms |
| CPU média: consumer(s) / `localstack` (pico) / `postgres` | 48% / 39% (101%) / 35% | 3 × 38% / 65% (101%) / 68% |
| Outbox lag máx / outbox zerada depois | 0,5 s / 0,1 s | 0,8 s / 0,1 s |
| Transações persistidas (acumulado) / DLQ | 50.000 `PROCESSED` / 0 | 100.000 `PROCESSED` / 0 |

Nenhuma mensagem perdida, duplicada ou mandada para a DLQ: `wagering_transactions_total` subiu exatamente 50.000 em cada rodada, as linhas `provider_id='provider-load'` no banco somam 100.000 ao final, não houve redelivery (`wagering_duplicates_total` Δ 0), e as 1.000 wallets reconciliaram.

Leitura:
- **Com 1 consumer, a vazão depende da profundidade da fila**: 122 msg/s com mais de 20 mil mensagens, 197 msg/s nas últimas 10 mil. Na rodada exploratória, com só 5.000 mensagens, a média foi 249 msg/s. O consumer usa só 48% de CPU, e o processamento é de ~4 ms por mensagem. O tempo que sobra está no `ReceiveMessage` do LocalStack, cujo custo cresce com o número de mensagens e grupos na fila FIFO. Essa característica é do emulador. Não há como afirmar que a AWS se comporta assim.
- **3 consumers dão 2,6×, não 3×**. O LocalStack é um processo Python único e bate ~100% de CPU nos picos. Ele recebe, por mensagem, um `DeleteMessage` individual (o consumer não usa `DeleteMessageBatch`) mais 1/10 de `ReceiveMessage`, e ainda os `SendMessageBatch` do outbox publisher para `wallet-events.fifo`. O Postgres sobe para 68% e ainda tem folga.
- Cada consumer tem **um único receive em voo**: recebe até 10, processa os grupos em paralelo, espera o mais lento e só então pede mais. Com ~4 ms por mensagem, a latência de ida e volta ao SQS domina.
- Na rodada exploratória (5.000 mensagens, 3 consumers), as últimas 46 mensagens ficaram ~14 s paradas antes de sumir. É compatível com um long poll (`WaitTimeSeconds=20`) do LocalStack que não acorda quando um grupo FIFO é liberado. Isso não se repetiu na rodada oficial, mas é uma cauda possível com o emulador.

### Soak

176.993 requisições a 295,0 req/s, todas 200, 100% dos checks e só 8 iterações descartadas. Do lado do serviço: `PROCESSED` +176.993, `pg_stat_database` +209.949 commits, 0 rollbacks e 0 deadlocks. A outbox teve no máximo 301 pendentes e 0,58 s de lag, e zerou 0,13 s depois da carga. As 1.000 wallets reconciliaram.

| Minuto | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| p50 (ms) | 3,5 | 3,2 | 3,3 | 3,3 | 3,3 | 3,4 | 3,3 | 3,3 | 3,4 | 3,6 |
| p99 (ms) | 22,1 | 13,3 | 10,7 | 14,7 | 11,5 | 15,3 | 20,3 | 25,4 | 20,7 | 26,3 |
| máx (ms) | 158 | 51 | 37 | 59 | 43 | 161 | 147 | 255 | 174 | 112 |

Memória (MiB, `docker stats`, início → máximo → fim): `api` 121 → 154 → 139, `workers` 103 → 137 → 118, `postgres` 98 → 286 → 233 (cache de páginas), `localstack` 131 → 892 → 871.

Leitura:
- Não há degradação de mediana em 10 min. O p99 sobe levemente na segunda metade (de 11–15 ms para 20–26 ms), o que é compatível com o crescimento das tabelas e índices: ~640 mil linhas inseridas, com `blks_read` subindo para 264 mil e páginas começando a sair do cache. Em 10 min, isso não chega a ser tendência confirmada.
- A memória dos processos Bun não cresce. A do LocalStack cresce de forma linear, ~74 MiB/min, porque `wallet-events.fifo` acumula todos os eventos publicados e nada os consome. Num soak mais longo, isso esgotaria a memória da VM. É um artefato do ambiente de teste (em produção haveria consumidores), mas também é um lembrete de que a fila de eventos precisa de consumidor ou de retenção.
- A CPU da `api` ficou em 51% e a do Postgres em 49%, coerente com metade da capacidade.

## Variação entre rodadas

Cada cenário padrão rodou duas vezes (rodada exploratória e rodada oficial), com stack nova a cada vez. O soak rodou uma vez só, porque não houve rodada exploratória de 10 min. Para ele, a única medida de variação disponível é a de minuto a minuto dentro da própria rodada (p50 de 3,2 a 3,6 ms, p99 de 11 a 26 ms; ver [Soak](#soak)).

| Medida | Exploratória | Oficial |
|---|---|---|
| distributed, degrau de 300: p99 | 15,9 ms | 139,1 ms |
| distributed, degrau de 400: p95 / p99 | 18,5 / 65,7 ms | 67,3 / 252,7 ms |
| distributed, degrau de 500: atingido / p95 | 498,8 / 198,8 ms | 481,9 / 688,7 ms |
| distributed, throughput máximo | 553 req/s (degraus de 600 e 800) | 590 req/s |
| hot-wallet `hot10` / `hot1`: p99 | 82 / 122 ms | 106 / 183 ms |
| duplicates: p99 / máx | 22,4 / 111 ms | 267,5 / 2.366 ms |
| drain, 3 consumers | 5.000 mensagens: 171 msg/s, por causa da cauda de 14 s | 50.000: 361 msg/s |

As medianas se repetem bem (±1 ms). As caudas variam de 2× a 10× entre rodadas na mesma máquina, e o throughput máximo varia ~7%. **p99 e máximos deste relatório são indicativos, não números de capacidade.** Medi-los com confiança exigiria repetir cada cenário várias vezes, numa máquina dedicada.

## Gargalos observados

1. **Um núcleo por processo na `api`** (principal limite da carga distribuída). Evidências: a CPU da `api` estabiliza em 96 a 97% (um núcleo) nos degraus de 600 e 700, apesar do limite de 2 CPUs. O Postgres fica em 111% de 200%, com em média menos de 1 backend ativo. As conexões *idle in transaction* sobem de 0,3 para 17,7 de um pool de 20. Ou seja, as transações estão abertas no Postgres esperando a aplicação, que não é escalonada porque o event loop está saturado. A duração medida no serviço (`wagering_processing_duration_seconds{source="http"}`) chega a média de 239 ms, porque inclui a espera por conexão do pool e pelo event loop.
2. **Serialização por wallet** (limite da hot wallet, ~333 tx/s por wallet). Evidências: `Lock:tuple` em 84% das esperas, 18,5 locks não concedidos em média (máximo 19 = pool − 1), CPU da `api` em 60%. Há um efeito colateral importante: **uma wallet quente ocupa o pool inteiro do processo**. Com as 20 conexões presas na fila do lock de uma linha, uma requisição para qualquer outra wallet servida pela mesma `api` também esperaria por conexão. É uma inferência (o cenário só tinha uma wallet ativa nessa fase), mas decorre diretamente de 19 de 20 conexões aguardando lock.
3. **Pool de 20 conexões.** No distribuído, o pool não é o primeiro limite (a CPU da `api` satura antes), mas é onde a fila aparece: 17,7 conexões em transação aguardando a aplicação. Na hot wallet, o pool é a própria fila. Aumentar o pool não aumentaria o teto de ~333 tx/s por wallet, só a fila no Postgres.
4. **Commit síncrono no Postgres.** `IO:WalSync` + `LWLock:WALWrite` somam ~27% das esperas ativas no distribuído. Cada transação financeira faz fsync no commit. É o próximo limite depois da CPU da `api`, e o que mais pesa no tempo de lock da hot wallet.
5. **Caminho SQS limitado pelo LocalStack e pelo desenho do consumer**: um receive em voo por processo e um `DeleteMessage` por mensagem. Ver a seção de drenagem.
6. **Não observados**: deadlocks (0), lock timeouts (`db_lock_conflicts_total` = 0 em todos os cenários), retries (0), DLQ (0), crescimento de outbox (lag máximo < 3 s, zerada em < 0,3 s depois da carga).

## O que mudaria para escalar

Em ordem de retorno esperado:

1. **Mais processos de `api`.** O serviço é stateless: réplicas atrás de um balanceador ou, dentro do container, vários processos Bun com `reusePort` para usar as 2 CPUs. O ganho esperado é quase linear até o Postgres. Pela CPU medida (~111% em 590 req/s), um Postgres com 2 CPUs comportaria por volta de 1.000 req/s antes de virar o gargalo. A estimativa não foi medida.
2. **Isolar wallets quentes do pool.** Um limite de concorrência por wallet antes de pedir conexão (fila ou semáforo por `walletId` no processo) faria uma wallet quente esperar na aplicação, sem segurar as 20 conexões. Roteamento por `walletId` (partição de consumers e afinidade na `api`) evitaria também a disputa entre instâncias.
3. **Encurtar a transação sob lock** para subir o teto por wallet: menos idas e voltas (inserts de ledger, transação e outbox numa única instrução ou CTE, ou uma função no banco) e WAL num disco de baixa latência. Desligar `synchronous_commit` não é opção para dinheiro. Para wallets realmente quentes, aplicar vários comandos da mesma wallet sob um único lock e um único commit (micro-batch), mantendo a idempotência por comando.
4. **Consumer**: `DeleteMessageBatch` ao fim de cada lote, vários loops de receive por processo (pipelining) e mais consumers. Na AWS, a fila FIFO sem *high throughput mode* tem limite de 300 operações/s por ação (3.000 mensagens/s com lote de 10). Acima disso, seria preciso ativar o *high throughput mode*, em que os limites passam a valer por grupo de mensagens, o que combina com `MessageGroupId = walletId`.
5. **Postgres**: monitorar o crescimento de `wallet_ledger_entries`/`outbox_messages` (purga ou particionamento das mensagens publicadas) e réplicas de leitura para as consultas (`GET /wallets`, ledger), que hoje competem com as escritas.

## Limitações

- **LocalStack não é a AWS.** O LocalStack é um único processo Python, sem latência de rede real, sem throttling e com custo de receive que cresce com a profundidade da fila FIFO. Os números de drenagem medem o emulador tanto quanto o consumer. A AWS tem outros limites (ver o item 4 acima) e latência de rede entre serviço e SQS, que aqui é zero.
- **Máquina única.** Os 4 CPUs da VM Docker são compartilhados por todos os serviços e pelo k6 (que usou até 44% de um núcleo). Os limites de cgroup são tetos, não núcleos dedicados, e a soma deles passa da VM. Não há rede real entre os serviços (bridge do Docker na mesma VM).
- **k6 no mesmo host e com `maxVUs` de 300.** Acima da saturação, a latência reportada é limitada pelo teto de requisições em voo. Com mais VUs ela seria maior, e o throughput não mudaria.
- **Durações curtas.** São 30 s por degrau, 60 a 120 s por fase e 10 min de soak. Efeitos de longo prazo (autovacuum, crescimento de índices, *bloat*, checkpoints de bancos grandes) não foram exercitados: o maior cenário, o soak, insere ~640 mil linhas (o distribuído, ~330 mil).
- **Amostragem grossa.** São 1 s para `pg_stat_activity` e ~3 s para `docker stats`, e os quantis do lado do serviço vêm dos buckets padrão do prom-client. As porcentagens de espera são proporções de amostras, não tempo exato.
- **Variação.** São duas rodadas por cenário. As caudas variaram até 10×, e houve uma parada de ~2 s não explicada no cenário de duplicatas (ver acima).
- **O mix não inclui `REFUND`/`ROLLBACK` nem `PENDING_REFERENCE`.** O worker de pendências ficou ocioso, e esses caminhos estão cobertos pelas suítes de concorrência e E2E, não por carga.
- **Ambiente de desenvolvimento.** Postgres com configuração padrão (`shared_buffers` de 128 MB, por exemplo) e logs `info` no stdout do Docker, sem nenhum tuning.

## Como reproduzir

```bash
docker compose -f compose.test.yml stop     # se a infra de teste estiver no ar: libera CPU
bun run test:load                           # distributed, hot-wallet, duplicates, sqs-drain (~22 min)
bun run test:load --scenario soak           # 10 min a 50% do throughput máximo do último distributed
bun run test:load --scenario hot-wallet --rate 300
bun run test:load --scenario drain --messages 20000 --consumers 2
```

Saída: `test/load/results/<timestamp>/summary.md` (tabelas; `bun test/load/rerender.ts <diretório>` o regenera a partir dos JSONs, sem rodar carga), `<cenário>.json` (números extraídos, com as amostras brutas de `pg_stat_activity` e `docker stats` e a linha do tempo da fila) e `<cenário>.k6.json` (`--summary-export` do k6).
