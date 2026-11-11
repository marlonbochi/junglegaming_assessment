# Distributed Wagering Processor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o processador de apostas distribuído do desafio Jungle Gaming — correto sob duplicatas, fora de ordem, ≥3 instâncias e crashes — com testes unitários, integração, concorrência, E2E e carga.

**Architecture:** Monólito modular hexagonal (`domain` puro → `application` com use cases e ports → `infrastructure` com MikroORM/SQS → `interfaces` HTTP/SQS/workers), três entrypoints (`api`, `consumer`, `workers`). Concorrência por `SELECT … FOR UPDATE` na wallet; invariantes duplicadas no schema PostgreSQL; transactional inbox/outbox.

**Tech Stack:** Bun 1.4.x, TypeScript strict, NestJS 12 (`@nestjs/platform-express`), MikroORM 7 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`, `@mikro-orm/nestjs`), PostgreSQL 17, LocalStack 4 (SQS), `@aws-sdk/client-sqs`, zod 4, pino, prom-client, k6 (Docker), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-10-wagering-processor-design.md` — leia junto. Regras invioláveis: `docs/constitution.md` (vence qualquer conflito).

## Global Constraints

- Dinheiro: nunca `number`. Domínio em `bigint` minor units; contrato `^(0|[1-9]\d{0,17})\.\d{2}$`; banco `numeric(20,2)` + `char(3)`.
- `src/domain/**` não importa `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, `pino`, `prom-client`, `zod`.
- Entidades: construtor `private`; factories `create`/`open`/`from`/`rehydrate`; `rehydrate` não valida.
- MikroORM: `defineEntity` + `setClass` (sem decorators); `driver: PostgreSqlDriver` explícito em toda config.
- Lock: sempre wallet primeiro (`FOR UPDATE`), no máximo uma wallet por transação SQL.
- IDs: UUID v7 via `Bun.randomUUIDv7()` atrás da port `IdGenerator`.
- Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive `maxReceiveCount=5`), `wallet-events.fifo`.
- Backoffs: outbox base 1s, ×2, teto 5min, sem limite; pending reference base 2s, ×2, teto 60s, 10 tentativas ou TTL 15min; consumer transitório base 1s, ×2, teto 60s. Jitter em todos (desligável em teste).
- `SET LOCAL lock_timeout = '5s'` e `statement_timeout = '15s'` em toda `UnitOfWork.run`.
- Testes não-unitários usam Postgres e LocalStack reais; sincronização via `eventually`, nunca `sleep` como garantia.
- `bun run typecheck` passa em todo commit. Mensagens de commit em inglês, formato conventional commits.
- Código, identificadores e nomes de teste em inglês; docs do repositório em português.

## Review Focus

1. **Espaços/dígitos não-ASCII em `amount`** (`" 25.00"`, `"25.00 "`, `"٢٥.٠٠"`, `"+25.00"`) → `InvalidMoneyError`/400, nunca aceito. Teste no Task 2.
2. **Crédito que estoura `numeric(20,2)`** (saldo perto de `999999999999999999.99` + WIN) → `REJECTED` com `BALANCE_LIMIT_EXCEEDED`, não 500 por overflow do Postgres. `FailureCode` novo, testes nos Tasks 4 e 6.
3. **Body HTTP malformado** (JSON inválido, `amount` numérico `25`, `walletId` que não é UUID, campos extras) → 400 `INVALID_PAYLOAD`, nunca 500 por cast de UUID no Postgres. Teste no Task 14.
4. **Cursor adulterado** (base64 válido com `v` negativo, string, float, JSON inválido) → 400 `INVALID_CURSOR`. Teste no Task 13.
5. **Header `Idempotency-Key` diferente do default** (`k1` para `provider-a:tx-1` e depois `k2` para o mesmo `externalTransactionId`) → 409 `EXTERNAL_ID_CONFLICT`; key arbitrária sem relação com o body é aceita na primeira vez. Teste no Task 12.

---

## File Structure

```
package.json  tsconfig.json  bunfig.toml  .env.example  .gitignore  Dockerfile  .dockerignore
compose.yml                 # infra + api/consumer/workers/migrate
compose.test.yml            # postgres + localstack para integração/concorrência
compose.load.yml            # override com cpus/mem_limit
infra/localstack/init/ready.d/01-queues.sh
infra/keycloak/realm-wagering.json                      (Task 23)
mikro-orm.config.ts
src/
  domain/shared/{domain-error.ts, failure-code.ts, invalid-transaction-state.error.ts}
  domain/money/{money.ts, money.errors.ts}
  domain/wallet/{wallet.ts, wallet-ledger-entry.ts, wallet.errors.ts}
  domain/wagering/{wager-transaction.ts, wager-transaction.types.ts, wager-settlement.ts}
  domain/messaging/{backoff.ts, inbox-message.ts, outbox-message.ts}
  domain/events/{integration-event.ts, wager-transaction-processed.ts, wager-transaction-rejected.ts,
                 wager-transaction-pending-reference.ts, wallet-balance-changed.ts}
  application/hashing/{canonical-json.ts, payload-hash.ts}
  application/ports/{unit-of-work.ts, repositories.ts, clock.ts, id-generator.ts, fault-injector.ts,
                     event-publisher.ts, provider-identity.ts, metrics.ts}
  application/commands/wager-command.ts
  application/errors.ts
  application/use-cases/{open-wallet.ts, submit-wager-transaction.ts, get-wallet.ts, list-ledger.ts,
                         get-transaction.ts, reconcile-wallet.ts, publish-outbox.ts, retry-pending-references.ts}
  infrastructure/config/env.ts
  infrastructure/persistence/{money-amount.type.ts, schemas/*.schema.ts, mappers/*.mapper.ts,
                              repositories/*.repository.ts, mikro-orm-unit-of-work.ts, pg-errors.ts}
  infrastructure/persistence/migrations/Migration20261111000000Initial.ts
  infrastructure/sqs/{sqs-client.ts, sqs-event-publisher.ts}
  infrastructure/observability/{logger.ts, request-context.ts, metrics.ts, health.ts}
  infrastructure/runtime/{system-clock.ts, uuid-v7-id-generator.ts, env-fault-injector.ts}
  infrastructure/auth/{noop-auth.guard.ts, noop-provider-identity.ts, keycloak-jwt.guard.ts}
  interfaces/http/{app.module.ts, problem-details.filter.ts, zod-validation.pipe.ts, dto/*.ts,
                   wallets.controller.ts, wagering.controller.ts, providers.controller.ts, health.controller.ts}
  interfaces/sqs/{wager-message.schema.ts, consumer-decision.ts, wager-transaction.consumer.ts, consumer.module.ts}
  interfaces/workers/{outbox-publisher.worker.ts, pending-reference.worker.ts, workers.module.ts}
  interfaces/ops-http.ts      # /health + /metrics mínimo para consumer e workers
  main.api.ts  main.consumer.ts  main.workers.ts  main.migrate.ts
test/
  support/{eventually.ts, db.ts, setup-integration.ts, sql.ts, ledger-consistency.ts, sqs.ts,
           processes.ts, fixtures.ts, http.ts}
  unit/**  integration/**  concurrency/**  e2e/**
  load/{k6/*.js, run.ts}
docs/{constitution.md, load-test-report.md}  README.md  ARCHITECTURE.md
```

---

### Task 1: Scaffold, infraestrutura de teste e helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.env.example`, `compose.test.yml`, `infra/localstack/init/ready.d/01-queues.sh`, `test/support/eventually.ts`, `test/unit/support/eventually.test.ts`

**Interfaces:**
- Produces: `eventually<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<T>` — reexecuta até `fn` resolver sem lançar; ao estourar o tempo relança o último erro. Defaults `timeoutMs=10_000`, `intervalMs=100`.
- Produces scripts em `package.json`: `typecheck` (`tsc --noEmit`), `test:unit` (`bun test test/unit`), `test:integration` (`bun run infra:test:up && bun test --preload ./test/support/setup-integration.ts test/integration`), `test:concurrency` (idem com `test/concurrency`, `--timeout 120000`), `test:e2e`, `test` (encadeia `typecheck && test:unit && test:integration && test:concurrency && test:e2e`), `test:load`, `infra:test:up` (`docker compose -f compose.test.yml up -d --wait`), `infra:test:down`, `db:migrate`, `db:migrate:down`.

- [ ] **Step 1: `git init` (se ainda não existir), `bun init`, instalar dependências** — runtime: `@nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs @mikro-orm/core @mikro-orm/postgresql @mikro-orm/migrations @mikro-orm/nestjs @aws-sdk/client-sqs zod pino prom-client`; dev: `typescript bun-types`.
- [ ] **Step 2: `tsconfig.json`** com `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields: false`, `target ES2022`, `module ESNext`, `moduleResolution bundler`, `types: ["bun-types"]`. `.gitignore` com `node_modules`, `.env`, `test/load/results`.
- [ ] **Step 3: `compose.test.yml`** — `postgres:17-alpine` (porta `55432`, `POSTGRES_PASSWORD=postgres`, healthcheck `pg_isready`, `max_connections=300`) e `localstack/localstack:4` (porta `4566`, `SERVICES=sqs`, monta `infra/localstack/init/ready.d`, healthcheck em `/_localstack/health`). `01-queues.sh` cria via `awslocal` a DLQ FIFO, a `wager-transactions.fifo` com `RedrivePolicy={"deadLetterTargetArn":<dlq arn>,"maxReceiveCount":"5"}`, `VisibilityTimeout=30`, `ContentBasedDeduplication=false`, e `wallet-events.fifo`.
- [ ] **Step 4: Escrever o teste falhando** `test/unit/support/eventually.test.ts`:

```ts
test('resolves once fn stops throwing', async () => {
  let calls = 0;
  const v = await eventually(async () => { if (++calls < 3) throw new Error('nope'); return 'ok'; }, { intervalMs: 1 });
  expect(v).toBe('ok'); expect(calls).toBe(3);
});
test('rethrows last error after timeout', async () => {
  await expect(eventually(async () => { throw new Error('still failing'); }, { timeoutMs: 50, intervalMs: 5 }))
    .rejects.toThrow('still failing');
});
```

- [ ] **Step 5: Rodar** `bun test test/unit/support` → FAIL (módulo inexistente).
- [ ] **Step 6: Implementar `eventually`** em `test/support/eventually.ts`.
- [ ] **Step 7: Rodar** `bun test test/unit/support && bun run typecheck` → PASS. `bun run infra:test:up` → ambos healthy; `docker compose -f compose.test.yml exec localstack awslocal sqs list-queues` lista as 3 filas.
- [ ] **Step 8: Commit** — `chore: scaffold bun + nest project and test infrastructure` (incluir `docs/` já existentes).

---

### Task 2: Money

**Files:**
- Create: `src/domain/money/money.ts`, `src/domain/money/money.errors.ts`, `src/domain/shared/domain-error.ts`
- Test: `test/unit/domain/money.test.ts`

**Interfaces:**
- Produces:
  - `abstract class DomainError extends Error { abstract readonly code: string }`
  - `interface MoneyProps { amount: string; currency: string }`
  - `class Money { static from(p: MoneyProps): Money; static zero(currency: string): Money; static fromMinorUnits(units: bigint, currency: string): Money; readonly currency: string; get minorUnits(): bigint; add(o): Money; subtract(o): Money; negate(): Money; isZero(); isPositive(); isNegative(); isLessThan(o): boolean; equals(o): boolean; exceedsStorageLimit(): boolean; toJSON(): MoneyProps; toString(): string }`
  - `const MONEY_MAX_MINOR_UNITS = 99_999_999_999_999_999_999n` (máximo de `numeric(20,2)`)
  - `class InvalidMoneyError extends DomainError` (`code = 'INVALID_MONEY'`), `class CurrencyMismatchError extends DomainError` (`code = 'CURRENCY_MISMATCH'`)

- [ ] **Step 1: Escrever os testes falhando**

```ts
describe('Money.from', () => {
  test.each(['0.00', '25.00', '999999999999999999.99'])('accepts %s', (a) =>
    expect(Money.from({ amount: a, currency: 'BRL' }).toJSON()).toEqual({ amount: a, currency: 'BRL' }));
  test.each(['', 'NaN', 'Infinity', '1e3', '25', '25.0', '1.234', '-1.00', '+1.00', '01.00', ' 25.00', '25.00 ',
             '٢٥.٠٠', '1000000000000000000.00', '25,00'])('rejects %p', (a) =>
    expect(() => Money.from({ amount: a, currency: 'BRL' })).toThrow(InvalidMoneyError));
  test.each(['brl', 'BR', 'BRLL', '', '12A'])('rejects currency %p', (c) =>
    expect(() => Money.from({ amount: '1.00', currency: c })).toThrow(InvalidMoneyError));
});
test('arithmetic is exact and immutable', () => {
  const a = Money.from({ amount: '0.10', currency: 'BRL' }), b = Money.from({ amount: '0.20', currency: 'BRL' });
  expect(a.add(b).toJSON().amount).toBe('0.30');
  expect(a.toJSON().amount).toBe('0.10');
  expect(a.subtract(b).isNegative()).toBe(true);
  expect(a.subtract(b).toJSON().amount).toBe('-0.10');
  expect(a.negate().negate().equals(a)).toBe(true);
});
test('currency mismatch throws', () => {
  expect(() => Money.zero('BRL').add(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  expect(() => Money.zero('BRL').isLessThan(Money.zero('USD'))).toThrow(CurrencyMismatchError);
});
test('storage limit', () => {
  const max = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
  expect(max.exceedsStorageLimit()).toBe(false);
  expect(max.add(Money.from({ amount: '0.01', currency: 'BRL' })).exceedsStorageLimit()).toBe(true);
});
test('toString', () => expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00 BRL'));
```

- [ ] **Step 2: Rodar** `bun test test/unit/domain/money.test.ts` → FAIL.
- [ ] **Step 3: Implementar** — parse por regex do Global Constraints (ASCII `[0-9]`, não `\d` com flag `u`); `BigInt(int + frac)`; `toJSON` formata com sinal e `padStart(3,'0')`. Moeda `^[A-Z]{3}$`.
- [ ] **Step 4: Rodar** testes + `bun run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(domain): add Money value object`

---

### Task 3: FailureCode, erros compartilhados e WalletLedgerEntry

**Files:**
- Create: `src/domain/shared/failure-code.ts`, `src/domain/shared/invalid-transaction-state.error.ts`, `src/domain/wallet/wallet-ledger-entry.ts`
- Test: `test/unit/domain/wallet-ledger-entry.test.ts`

**Interfaces:**
- Produces:
  - `enum FailureCode { InsufficientFunds='INSUFFICIENT_FUNDS', ReversalInsufficientFunds='REVERSAL_INSUFFICIENT_FUNDS', BalanceLimitExceeded='BALANCE_LIMIT_EXCEEDED', CurrencyMismatch='CURRENCY_MISMATCH', PlayerWalletMismatch='PLAYER_WALLET_MISMATCH', ReferenceNotFound='REFERENCE_NOT_FOUND', ReferenceMismatch='REFERENCE_MISMATCH', ReferenceKindNotAllowed='REFERENCE_KIND_NOT_ALLOWED', ReferenceAmountMismatch='REFERENCE_AMOUNT_MISMATCH', ReferenceAlreadyReversed='REFERENCE_ALREADY_REVERSED', ReferenceNotReversible='REFERENCE_NOT_REVERSIBLE', InternalProcessingError='INTERNAL_PROCESSING_ERROR' }`
  - `class InvalidTransactionStateError extends Error` (erro de programação, **não** `DomainError`)
  - `enum LedgerDirection { Debit='DEBIT', Credit='CREDIT' }`
  - `interface LedgerEntryState { id; walletId; transactionId; direction: LedgerDirection; money: Money; balanceBefore: Money; balanceAfter: Money; walletVersion: number; createdAt: Date }`
  - `class WalletLedgerEntry { readonly …LedgerEntryState; static create(p: LedgerEntryState): WalletLedgerEntry; static rehydrate(s: LedgerEntryState): WalletLedgerEntry; isBalanced(): boolean }`
  - `class UnbalancedLedgerEntryError extends Error`

- [ ] **Step 1: Escrever os testes falhando**

```ts
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const base = { id: 'e1', walletId: 'w1', transactionId: 't1', walletVersion: 2, createdAt: new Date(0) };
test('debit entry balanced', () => {
  const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('80.00'), balanceBefore: brl('100.00'), balanceAfter: brl('20.00') });
  expect(e.isBalanced()).toBe(true);
});
test('credit entry with wrong arithmetic throws', () =>
  expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('10.00'), balanceBefore: brl('0.00'), balanceAfter: brl('9.99') })).toThrow(UnbalancedLedgerEntryError));
test('zero amount throws', () =>
  expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') })).toThrow(UnbalancedLedgerEntryError));
test('negative balanceAfter throws', () =>
  expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('2.00'), balanceBefore: brl('1.00'), balanceAfter: brl('-1.00') })).toThrow(UnbalancedLedgerEntryError));
test('mixed currencies throw', () =>
  expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: Money.from({ amount: '1.00', currency: 'USD' }), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') })).toThrow());
test('rehydrate does not validate', () =>
  expect(WalletLedgerEntry.rehydrate({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('5.00') }).isBalanced()).toBe(false));
test('is structurally immutable', () => {
  const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
  expect(Object.isFrozen(e)).toBe(true);
});
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar** (`Object.freeze(this)` no construtor). **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(domain): add failure codes and immutable ledger entry`

---

### Task 4: Wallet (aggregate root)

**Files:**
- Create: `src/domain/wallet/wallet.ts`, `src/domain/wallet/wallet.errors.ts`
- Test: `test/unit/domain/wallet.test.ts`

**Interfaces:**
- Consumes: `Money`, `WalletLedgerEntry`, `LedgerDirection` (Tasks 2–3).
- Produces:
  - `interface WalletState { id; playerId; currency; balance: Money; version: number; createdAt: Date; updatedAt: Date }`
  - `interface BalanceChange { money: Money; transactionId: string; entryId: string; now: Date }`
  - `class Wallet { static open(p: { id: string; playerId: string; initialBalance: Money; openingTransactionId: string; openingEntryId: string; now: Date }): { wallet: Wallet; openingEntry?: WalletLedgerEntry }; static rehydrate(s: WalletState): Wallet; get balance(); get version(); get updatedAt(); readonly id; readonly playerId; readonly currency; readonly createdAt; debit(c: BalanceChange): WalletLedgerEntry; credit(c: BalanceChange): WalletLedgerEntry; toState(): WalletState }`
  - `class InsufficientFundsError extends DomainError` (`code='INSUFFICIENT_FUNDS'`), `class BalanceLimitExceededError extends DomainError` (`code='BALANCE_LIMIT_EXCEEDED'`)

- [ ] **Step 1: Escrever os testes falhando**

```ts
const now = new Date('2026-11-11T00:00:00Z');
const open = (amount: string) => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), openingTransactionId: 't0', openingEntryId: 'e0', now });
test('open with positive balance: version 1 and opening credit entry v1', () => {
  const { wallet, openingEntry } = open('100.00');
  expect(wallet.version).toBe(1); expect(wallet.balance.toJSON().amount).toBe('100.00');
  expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
  expect(openingEntry?.walletVersion).toBe(1);
  expect(openingEntry?.balanceBefore.isZero()).toBe(true);
});
test('open with zero balance: no entry, version 1', () => {
  const { wallet, openingEntry } = open('0.00');
  expect(openingEntry).toBeUndefined(); expect(wallet.version).toBe(1);
});
test('debit returns balanced entry and bumps version', () => {
  const { wallet } = open('100.00');
  const e = wallet.debit({ money: brl('80.00'), transactionId: 't1', entryId: 'e1', now });
  expect(wallet.balance.toJSON().amount).toBe('20.00'); expect(wallet.version).toBe(2);
  expect(e.walletVersion).toBe(2); expect(e.balanceBefore.toJSON().amount).toBe('100.00'); expect(e.balanceAfter.toJSON().amount).toBe('20.00');
});
test('debit beyond balance throws and leaves state untouched', () => {
  const { wallet } = open('20.00');
  expect(() => wallet.debit({ money: brl('80.00'), transactionId: 't1', entryId: 'e1', now })).toThrow(InsufficientFundsError);
  expect(wallet.balance.toJSON().amount).toBe('20.00'); expect(wallet.version).toBe(1);
});
test('credit beyond storage limit throws BalanceLimitExceededError', () => {
  const { wallet } = open('999999999999999999.99');
  expect(() => wallet.credit({ money: brl('0.01'), transactionId: 't1', entryId: 'e1', now })).toThrow(BalanceLimitExceededError);
  expect(wallet.version).toBe(1);
});
test('currency mismatch on debit/credit', () => {
  const { wallet } = open('10.00');
  expect(() => wallet.credit({ money: Money.from({ amount: '1.00', currency: 'USD' }), transactionId: 't', entryId: 'e', now })).toThrow(CurrencyMismatchError);
});
test('open rejects negative initial balance', () =>
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), openingTransactionId: 't', openingEntryId: 'e', now })).toThrow(InvalidMoneyError));
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(domain): add Wallet aggregate`

---

### Task 5: WagerTransaction

**Files:**
- Create: `src/domain/wagering/wager-transaction.types.ts`, `src/domain/wagering/wager-transaction.ts`
- Test: `test/unit/domain/wager-transaction.test.ts`

**Interfaces:**
- Produces:
  - `enum WagerTransactionKind { Opening='OPENING', Bet='BET', Win='WIN', Loss='LOSS', Refund='REFUND', Rollback='ROLLBACK' }`
  - `enum WagerTransactionStatus { Pending='PENDING', PendingReference='PENDING_REFERENCE', Processed='PROCESSED', Rejected='REJECTED', Failed='FAILED' }`
  - `interface CreateWagerTransactionProps { id; providerId; externalTransactionId; idempotencyKey; payloadHash; walletId; playerId; roundId: string; gameId: string; kind: Exclude<WagerTransactionKind,'OPENING'>; money: Money; referenceExternalTransactionId?: string; now: Date }`
  - `interface WagerTransactionState` = todos os campos do README §6.3 + `observedBalance?: Money; attempts: number; nextAttemptAt?: Date; updatedAt: Date`; `roundId`/`gameId` `string | undefined` (só `OPENING` é `undefined`).
  - `class WagerTransaction` com: `static create(p)`, `static createOpening(p: { id; walletId; playerId; money: Money; now: Date })` (`providerId='internal'`, `externalTransactionId=walletId`, `idempotencyKey='opening:'+walletId`, `payloadHash = '0'.repeat(64)` (transação interna, nunca sujeita a replay externo), já nasce `PROCESSED` com `observedBalance = money`), `static rehydrate(s)`, getters, `markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date)`, `reject(code: FailureCode, observedBalance: Money, at: Date)`, `markPendingReference(nextAttemptAt: Date)`, `scheduleReferenceRetry(nextAttemptAt: Date)`, `fail(code: FailureCode, at: Date)`, `isTerminal()`, `affectsBalance()`, `requiresReference()`, `matchesPayload(hash)`, `ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined`, `toState()`.
  - `class MissingReferenceError extends DomainError` (`code='INVALID_PAYLOAD'`) lançado por `create` quando `REFUND`/`ROLLBACK` sem referência; `class OpeningNotAllowedError extends DomainError` (`code='INVALID_PAYLOAD'`) para `kind=OPENING` em `create`.

- [ ] **Step 1: Escrever os testes falhando** (fábrica `bet(overrides)` em `test/support/fixtures.ts`, que também serve aos Tasks 6+):

```ts
test('create starts PENDING with attempts 0', () => { const t = bet(); expect(t.status).toBe('PENDING'); expect(t.attempts).toBe(0); });
test.each(['REFUND','ROLLBACK'])('%s without reference throws', (k) => expect(() => tx({ kind: k, referenceExternalTransactionId: undefined })).toThrow(MissingReferenceError));
test('OPENING via create throws', () => expect(() => tx({ kind: 'OPENING' as never })).toThrow(OpeningNotAllowedError));
test('PENDING → PROCESSED sets processedAt, reference and observedBalance', () => {
  const t = bet(); t.markProcessed('ref-1', brl('20.00'), now);
  expect(t.status).toBe('PROCESSED'); expect(t.processedAt).toEqual(now); expect(t.referenceTransactionId).toBe('ref-1'); expect(t.observedBalance?.toJSON().amount).toBe('20.00');
});
test('PENDING → PENDING_REFERENCE → retry increments attempts → PROCESSED', () => {
  const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'b1' });
  t.markPendingReference(new Date(1)); t.scheduleReferenceRetry(new Date(2));
  expect(t.attempts).toBe(1); expect(t.nextAttemptAt).toEqual(new Date(2));
  t.markProcessed('ref', brl('1.00'), now); expect(t.isTerminal()).toBe(true);
});
test.each(['markProcessed','reject','fail','markPendingReference','scheduleReferenceRetry'])('terminal + %s throws InvalidTransactionStateError', (m) => {
  const t = bet(); t.reject(FailureCode.InsufficientFunds, brl('0.00'), now);
  expect(() => (t as any)[m](...argsFor(m))).toThrow(InvalidTransactionStateError);
});
test('markPendingReference only from PENDING', () => { const t = bet(); t.markPendingReference(now); expect(() => t.markPendingReference(now)).toThrow(InvalidTransactionStateError); });
test('affectsBalance false only for LOSS', () => { expect(tx({ kind: 'LOSS' }).affectsBalance()).toBe(false); expect(bet().affectsBalance()).toBe(true); });
test('ledgerDirectionFor', () => {
  expect(bet().ledgerDirectionFor()).toBe('DEBIT'); expect(tx({ kind: 'WIN' }).ledgerDirectionFor()).toBe('CREDIT');
  expect(tx({ kind: 'LOSS' }).ledgerDirectionFor()).toBeUndefined();
  const rb = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' });
  expect(rb.ledgerDirectionFor(bet())).toBe('CREDIT'); expect(rb.ledgerDirectionFor(tx({ kind: 'WIN' }))).toBe('DEBIT');
});
test('matchesPayload', () => { const t = bet({ payloadHash: 'a'.repeat(64) }); expect(t.matchesPayload('a'.repeat(64))).toBe(true); expect(t.matchesPayload('b'.repeat(64))).toBe(false); });
test('createOpening is PROCESSED with internal provider', () => {
  const o = WagerTransaction.createOpening({ id: 't0', walletId: 'w1', playerId: 'p1', money: brl('100.00'), now });
  expect(o.status).toBe('PROCESSED'); expect(o.providerId).toBe('internal'); expect(o.idempotencyKey).toBe('opening:w1');
});
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(domain): add WagerTransaction state machine`

---

### Task 6: WagerSettlement

**Files:**
- Create: `src/domain/wagering/wager-settlement.ts`
- Test: `test/unit/domain/wager-settlement.test.ts`

**Interfaces:**
- Consumes: `Wallet`, `WagerTransaction`, `FailureCode`, `WalletLedgerEntry`.
- Produces:
  - `type ReferenceLookup = { kind: 'none' } | { kind: 'missing' } | { kind: 'found'; transaction: WagerTransaction; alreadyReversed: boolean }` (`none` = transação não informou referência)
  - `interface SettlementInput { tx: WagerTransaction; wallet: Wallet; reference: ReferenceLookup; ledgerEntryId: string; now: Date; pendingRetryAt: Date }`
  - `type SettlementResult = { outcome: 'PROCESSED'; ledgerEntry?: WalletLedgerEntry } | { outcome: 'REJECTED'; failureCode: FailureCode } | { outcome: 'PENDING_REFERENCE' }`
  - `function settle(input: SettlementInput): SettlementResult` — aplica a transição em `tx` (`markProcessed`/`reject`/`markPendingReference`, ou `scheduleReferenceRetry` se `tx` já está `PENDING_REFERENCE`) e a mudança em `wallet`; `observedBalance` = saldo da wallet após a decisão.

Ordem de validação exatamente como spec §4.5 (identidade → referência 1–7 → regra por kind). `InsufficientFundsError` vira `INSUFFICIENT_FUNDS` para `BET` e `REVERSAL_INSUFFICIENT_FUNDS` para `ROLLBACK`; `BalanceLimitExceededError` vira `BALANCE_LIMIT_EXCEEDED`.

- [ ] **Step 1: Escrever os testes falhando** — um teste por linha da tabela; nomes e asserções:

```ts
// helper: run(tx, walletBalance, reference) → { result, tx, wallet }
test('BET with funds → PROCESSED, DEBIT entry, balance 20.00')            // result.outcome, ledgerEntry.direction, wallet.balance
test('BET without funds → REJECTED INSUFFICIENT_FUNDS, no entry, version unchanged, observedBalance 20.00')
test('WIN without reference → PROCESSED CREDIT')
test('WIN with reference to BET in another round → REJECTED REFERENCE_MISMATCH')
test('LOSS → PROCESSED, no entry, version unchanged')
test('REFUND of PROCESSED BET → PROCESSED CREDIT, tx.referenceTransactionId = bet.id')
test('REFUND referencing WIN → REJECTED REFERENCE_KIND_NOT_ALLOWED')
test('REFUND with different amount → REJECTED REFERENCE_AMOUNT_MISMATCH')
test('REFUND of already reversed BET → REJECTED REFERENCE_ALREADY_REVERSED')
test('ROLLBACK of BET → CREDIT; of WIN → DEBIT; of REFUND → DEBIT')
test('ROLLBACK of WIN without funds → REJECTED REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)')
test('ROLLBACK of LOSS → REJECTED REFERENCE_KIND_NOT_ALLOWED')
test('reference missing → PENDING_REFERENCE with nextAttemptAt = pendingRetryAt')
test('reference missing while tx already PENDING_REFERENCE → stays, attempts + 1')
test('reference PENDING_REFERENCE → PENDING_REFERENCE')
test('reference REJECTED → REJECTED REFERENCE_NOT_REVERSIBLE')
test.each(['providerId','playerId','walletId','roundId'])('reference with different %s → REFERENCE_MISMATCH')
test('player not owner → PLAYER_WALLET_MISMATCH (before reference checks)')
test('currency ≠ wallet currency → CURRENCY_MISMATCH')
test('WIN that overflows storage → REJECTED BALANCE_LIMIT_EXCEEDED')
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar `settle`.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(domain): add wager settlement rules`

---

### Task 7: Eventos de integração, Inbox, Outbox e backoff

**Files:**
- Create: `src/domain/messaging/backoff.ts`, `src/domain/messaging/inbox-message.ts`, `src/domain/messaging/outbox-message.ts`, `src/domain/events/*.ts` (5 arquivos)
- Test: `test/unit/domain/backoff.test.ts`, `test/unit/domain/events.test.ts`, `test/unit/domain/outbox-message.test.ts`, `test/unit/domain/inbox-message.test.ts`

**Interfaces:**
- Produces:
  - `interface BackoffPolicy { baseMs: number; capMs: number; jitter: () => number }` (`jitter` retorna fator em `[0,1)`; produção `Math.random`, testes `() => 0`)
  - `function backoffDelayMs(attempt: number, p: BackoffPolicy): number` — `delay = min(baseMs · 2^attempt, capMs)`; `delay += delay · 0.2 · jitter()`.
  - `function computeNextAttemptAt(now: Date, attempt: number, p: BackoffPolicy): Date` — `now + backoffDelayMs(attempt, p)`.
  - `const OUTBOX_BACKOFF = { baseMs: 1000, capMs: 300_000 }`, `const PENDING_REFERENCE_BACKOFF = { baseMs: 2000, capMs: 60_000 }`, `const CONSUMER_BACKOFF = { baseMs: 1000, capMs: 60_000 }`
  - `IntegrationEvent<T>` abstrata conforme README §11; `interface EventContext { eventId: string; correlationId: string; causationId?: string; occurredAt: Date }`
  - `WagerTransactionProcessed.from(tx: WagerTransaction, balance: Money, ctx)` — data `{ transactionId, providerId, externalTransactionId, walletId, playerId, roundId, kind, money: MoneyProps, balance: MoneyProps, referenceTransactionId? }`, `eventType='WagerTransactionProcessed'`, `version=1`, `aggregateId = walletId`.
  - `WagerTransactionRejected.from(tx, balance, ctx)` — mesmos campos + `failureCode`.
  - `WagerTransactionPendingReference.from(tx, ctx)` — `{ transactionId, providerId, externalTransactionId, walletId, kind, referenceExternalTransactionId, nextAttemptAt: string }`.
  - `WalletBalanceChanged.from(wallet: Wallet, entry: WalletLedgerEntry, ctx)` — data do README §11.
  - `InboxMessage.receive({ messageId, consumerName, payloadHash, now })` (já nasce com `processedAt = now`, ver spec §4.6), `rehydrate`, `isProcessed`, `markProcessed`.
  - `OutboxMessage.enqueue(event: IntegrationEvent<unknown>)` (`id = eventId`, `aggregateId`, `eventType`, `payload = event.toJSON()`, `attempts 0`, `nextAttemptAt = occurredAt`), `rehydrate`, `isPending`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now, jitter = Math.random)`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('backoff doubles and caps', () => {
  const p = { baseMs: 1000, capMs: 5000, jitter: () => 0 }, t0 = new Date(0);
  expect([0,1,2,3,10].map((a) => computeNextAttemptAt(t0, a, p).getTime())).toEqual([1000, 2000, 4000, 5000, 5000]);
});
test('jitter adds at most 20%', () => expect(backoffDelayMs(0, { baseMs: 1000, capMs: 5000, jitter: () => 0.999 })).toBeLessThan(1200));
test('WalletBalanceChanged envelope', () => {
  const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
  expect(json).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1, aggregateId: wallet.id, correlationId: ctx.correlationId, occurredAt: ctx.occurredAt.toISOString() });
  expect(json.data.money).toEqual({ amount: '80.00', currency: 'BRL' });
  expect(json.data.walletVersion).toBe(2);
  expect(JSON.parse(JSON.stringify(json))).toEqual(json); // JSON estável, sem instâncias de Money
});
test('each event subclass has eventType and version on the type', () => { /* 4 classes: eventType literal e version 1 */ });
test('outbox scheduleRetry increments attempts and moves nextAttemptAt', () => {
  const m = OutboxMessage.enqueue(evt); m.scheduleRetry(new Date(0), () => 0);
  expect(m.attempts).toBe(1); expect(m.nextAttemptAt?.getTime()).toBe(2000); expect(m.isDue(new Date(1999))).toBe(false);
});
test('outbox markPublished → not pending; markPublished twice throws', () => {});
test('inbox receive is processed', () => expect(InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', now }).isProcessed()).toBe(true));
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(domain): add integration events, inbox, outbox and backoff`

---

### Task 8: Canonical JSON, payload hash, comando e ports

**Files:**
- Create: `src/application/hashing/canonical-json.ts`, `src/application/hashing/payload-hash.ts`, `src/application/commands/wager-command.ts`, `src/application/errors.ts`, `src/application/ports/*.ts` (8 arquivos)
- Test: `test/unit/application/payload-hash.test.ts`

**Interfaces:**
- Produces:
  - `interface WagerCommand { providerId; externalTransactionId; idempotencyKey; playerId; walletId; roundId; gameId; kind: Exclude<WagerTransactionKind,'OPENING'>; money: MoneyProps; referenceExternalTransactionId?: string }`
  - `type SubmissionSource = { type: 'http' } | { type: 'sqs'; consumerName: string; messageId: string }`
  - `canonicalJson(v: unknown): string` — chaves ordenadas recursivamente, `undefined` omitido, sem espaços; lança para `number` não-inteiro, `bigint`, funções.
  - `payloadHash(cmd: WagerCommand): string` — sha256 hex (`new Bun.CryptoHasher('sha256')`) de `canonicalJson` com os 9 campos de negócio da spec §6.1; ignora `idempotencyKey`.
  - Erros de aplicação (`src/application/errors.ts`): `class ApplicationError extends Error { constructor(readonly code: AppErrorCode, msg?) }` com `type AppErrorCode = 'INVALID_PAYLOAD' | 'MISSING_IDEMPOTENCY_KEY' | 'WALLET_NOT_FOUND' | 'WALLET_ALREADY_EXISTS' | 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_ID_CONFLICT' | 'INBOX_PAYLOAD_MISMATCH' | 'NOT_FOUND' | 'INVALID_CURSOR'`; `class TransientInfraError extends Error`, `class PermanentInfraError extends Error`.
  - Ports (só tipos):
    - `UnitOfWork { run<T>(fn: (r: TxRepositories) => Promise<T>): Promise<T> }`
    - `TxRepositories { wallets: WalletRepository; transactions: WagerTransactionRepository; ledger: LedgerRepository; inbox: InboxRepository; outbox: OutboxRepository }`
    - `WalletRepository { lockById(id): Promise<Wallet | undefined>; findById(id): Promise<Wallet | undefined>; insert(w: Wallet): Promise<void>; update(w: Wallet): Promise<void> }`
    - `WagerTransactionRepository { findById(id); lockById(id); findByIdempotencyKey(key); findByExternalId(providerId, externalId); isReversed(transactionId): Promise<boolean>; insert(t); update(t); nudgeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>; findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>; countPendingReferences(): Promise<number> }` (finds retornam `WagerTransaction | undefined`)
    - `LedgerRepository { append(e: WalletLedgerEntry): Promise<void>; listByWallet(walletId, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>; totals(walletId, currency): Promise<{ credits: Money; debits: Money; count: number; lastBalanceAfter?: Money }> }`
    - `InboxRepository { find(consumerName, messageId): Promise<InboxMessage | undefined>; insert(m: InboxMessage): Promise<void> }`
    - `OutboxRepository { enqueue(m: OutboxMessage): Promise<void>; lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>; save(m: OutboxMessage): Promise<void>; lagSeconds(now: Date): Promise<number>; pendingCount(): Promise<number> }`
    - `Clock { now(): Date }`, `IdGenerator { next(): string }`
    - `type FaultPoint = 'after_ledger_append' | 'before_commit' | 'after_commit_before_ack' | 'after_publish_before_mark'`; `FaultInjector { hit(point: FaultPoint): void }`
    - `EventPublisher { publishBatch(messages: OutboxMessage[]): Promise<{ published: string[]; failed: string[] }> }`
    - `ProviderIdentityPort { assertMayActAs(providerId: string, principal: unknown): void }`
    - `Metrics` — métodos `transaction(status, kind, source)`, `duplicate(source, type)`, `retry(component)`, `dlq(reason)`, `lockConflict()`, `processingDuration(source, seconds)`, `reconciliationMismatch()`, `setOutboxLag(s)`, `setOutboxPending(n)`, `setPendingReferences(n)`; `const noopMetrics: Metrics`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('canonicalJson sorts keys recursively and drops undefined', () =>
  expect(canonicalJson({ b: 1, a: { d: undefined, c: 'x' } })).toBe('{"a":{"c":"x"},"b":1}'));
test('hash ignores key order and idempotencyKey', () =>
  expect(payloadHash({ ...cmd, idempotencyKey: 'other' })).toBe(payloadHash(reorderKeys(cmd))));
test('hash changes when a business field changes', () =>
  expect(payloadHash({ ...cmd, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(payloadHash(cmd)));
test('absent and undefined reference hash the same', () =>
  expect(payloadHash({ ...cmd, referenceExternalTransactionId: undefined })).toBe(payloadHash(omit(cmd, 'referenceExternalTransactionId'))));
test('hash is 64 hex chars and stable across runs', () => expect(payloadHash(cmd)).toBe('<valor fixo calculado uma vez e colado aqui>'));
test('canonicalJson rejects floats', () => expect(() => canonicalJson({ a: 1.5 })).toThrow());
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar** hashing e escrever os ports. **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(application): add payload hashing, command and ports`

---

### Task 9: Migration inicial e constraints do schema

**Files:**
- Create: `mikro-orm.config.ts`, `src/infrastructure/config/env.ts`, `src/infrastructure/persistence/migrations/Migration20261111000000Initial.ts`, `src/main.migrate.ts`, `test/support/sql.ts`, `test/support/db.ts`, `test/support/setup-integration.ts`
- Test: `test/integration/schema/migrations.test.ts`, `test/integration/schema/constraints.test.ts`

**Interfaces:**
- Produces:
  - `loadEnv(): Env` (zod) — `DATABASE_URL`, `AWS_ENDPOINT_URL`, `AWS_REGION` (default `us-east-1`), `WAGER_QUEUE_URL`, `WAGER_DLQ_URL`, `EVENTS_QUEUE_URL`, `PORT` (default 3000), `CONSUMER_NAME` (default `wager-transactions-consumer`), `SQS_VISIBILITY_TIMEOUT_S`=30, `SQS_MAX_RECEIVE`=5, `SHUTDOWN_GRACE_MS`=20000, `OUTBOX_BATCH`=50, `OUTBOX_POLL_MS`=250, `PENDING_REF_BATCH`=20, `PENDING_REF_POLL_MS`=500, `PENDING_REF_MAX_ATTEMPTS`=10, `PENDING_REF_TTL_MS`=900000, `DB_POOL_MAX`=20, `FAULT` (opcional, `"<FaultPoint>:<crash|throw>"`), `JITTER` (`on|off`, default `on`), `LOG_LEVEL`, `AUTH_MODE` (`none|keycloak`, default `none`).
  - `src/main.migrate.ts` — `bun src/main.migrate.ts up|down` usando `orm.migrator`.
  - `test/support/sql.ts`: `sqlClient(url: string): SQL` (Bun `SQL`).
  - `test/support/db.ts`: `createTestDatabase(): Promise<{ url: string; sql: SQL; drop(): Promise<void> }>` — `CREATE DATABASE wagering_<uuid sem hífen> TEMPLATE wagering_template`.
  - `test/support/setup-integration.ts` (passado via `--preload` nos scripts `test:integration` e `test:concurrency`, nunca em `test:unit`): recria `wagering_template` e roda as migrations nele uma vez por execução.

Migration `up` cria exatamente o schema da spec §5 (tabelas, `CHECK`s, `UNIQUE`s, índices parciais, triggers `wallets_version_guard`, constraint trigger `wallets_ledger_consistency` `DEFERRABLE INITIALLY DEFERRED`, `ledger_chain_guard`, `ledger_append_only` para `UPDATE/DELETE/TRUNCATE`, `wager_transactions_guard`, `outbox_guard`). `down` remove tudo em ordem inversa.

- [ ] **Step 1: Escrever os testes falhando** — `migrations.test.ts`: `up → down → up` termina sem erro e `down` deixa `information_schema.tables` sem as 5 tabelas. `constraints.test.ts` (cada um com SQL direto via `sql`, esperando `rejects.toThrow(/<nome da constraint ou mensagem do trigger>/)`):

```ts
test('wallet balance cannot be negative')                         // UPDATE balance = -1 → wallets_balance_check
test('one wallet per player + currency')                           // segundo INSERT → wallets_player_id_currency_key
test('wallet balance change without ledger entry fails at commit') // BEGIN; UPDATE balance/version; COMMIT → wallets_ledger_consistency
test('wallet version must bump iff balance changes')               // UPDATE só version → wallets_version_guard
test('ledger entries cannot be updated, deleted or truncated')     // 3 casos → ledger_append_only
test('ledger arithmetic is checked')                               // INSERT after ≠ before - amount → wallet_ledger_entries_arithmetic_check
test('ledger chain must continue from previous balance_after')     // ledger_chain_guard
test('ledger one entry per (wallet, transaction) and per (wallet, version)')
test('transaction idempotency_key and (provider, external id) are unique')
test('REFUND/ROLLBACK require reference_external_transaction_id')
test('REJECTED requires failure_code; PROCESSED requires processed_at')
test('a transaction can be reversed only once (any reversal kind)')  // segundo REFUND/ROLLBACK PROCESSED para a mesma referência → índice parcial
test('terminal transaction cannot change; business fields never change') // wager_transactions_guard
test('outbox payload cannot change and cannot be unpublished')      // outbox_guard
test('happy path insert (wallet + opening tx + entry) commits')     // garante que os guards não bloqueiam o caso válido
```

- [ ] **Step 2: Rodar** `bun run infra:test:up && bun test test/integration/schema` → FAIL.
- [ ] **Step 3: Implementar config, migration, `main.migrate.ts`, helpers de teste.**
- [ ] **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(persistence): add initial migration with schema-level invariants`

---

### Task 10: Persistência MikroORM — schemas, mappers, repositórios, UnitOfWork

**Files:**
- Create: `src/infrastructure/persistence/money-amount.type.ts`, `schemas/{wallet,ledger-entry,wager-transaction,inbox,outbox}.schema.ts`, `mappers/*.mapper.ts`, `repositories/*.repository.ts`, `mikro-orm-unit-of-work.ts`, `pg-errors.ts`, `src/infrastructure/runtime/{system-clock.ts, uuid-v7-id-generator.ts, env-fault-injector.ts}`
- Test: `test/integration/persistence/repositories.test.ts`, `test/integration/persistence/unit-of-work.test.ts`

**Interfaces:**
- Consumes: ports (Task 8), domínio (Tasks 2–7), migration (Task 9).
- Produces:
  - `MoneyAmountType extends Type<string, string>` — `numeric(20,2)`; `convertToJSValue` lança se o driver devolver algo que não seja string.
  - `createOrm(env: Env): Promise<MikroORM>` em `mikro-orm.config.ts` (pool `max = DB_POOL_MAX`, `allowGlobalContext: false`, `driver: PostgreSqlDriver`).
  - `class MikroOrmUnitOfWork implements UnitOfWork` — `em.fork().transactional(...)`, executa `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'`, instancia os 5 repositórios ligados ao `em` da transação, e traduz erros via `pg-errors.ts`.
  - `pg-errors.ts`: `classifyPgError(e: unknown): 'unique_violation' | 'lock_timeout' | 'transient' | 'other'` — `23505` unique; `55P03` lock timeout; `57014`, `08*`, `53300`, `ECONNREFUSED`/`ECONNRESET` transient. `MikroOrmUnitOfWork` relança `lock_timeout`/`transient` como `TransientInfraError` (`metrics.lockConflict()` para lock timeout) e preserva `unique_violation` como `UniqueViolationError { constraint: string }`.
  - `WalletRepository.lockById` usa `LockMode.PESSIMISTIC_WRITE`. `OutboxRepository.lockDueBatch` usa SQL `FOR UPDATE SKIP LOCKED`. Mappers usam `Domain.rehydrate`.
  - `EnvFaultInjector(spec?: string)` — `hit(point)`: se `point` casa, `crash` → `process.exit(137)`, `throw` → `throw new TransientInfraError('fault:'+point)` (transitório de propósito: não grava `FAILED` e faz o consumer reentregar).

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('wallet roundtrip keeps Money exact and as string', async () => { /* insert → findById → balance.toJSON() === {amount:'1000.00',currency:'BRL'} */ });
test('transaction roundtrip preserves every field incl. undefined round/game for OPENING');
test('ledger listByWallet is ordered by walletVersion and respects afterVersion/limit');
test('ledger totals sums credits and debits exactly');
test('lockById blocks a second locker until commit', async () => {
  // uow.run A: lockById(w) e espera um latch; uow.run B: lockById(w) → B só resolve depois de A commitar (ordem de timestamps)
});
test('unit of work rolls back everything when fn throws');
test('unit of work maps lock timeout to TransientInfraError', async () => {
  // A segura lock; B roda com SET LOCAL lock_timeout='100ms' (override de teste) → rejects TransientInfraError
});
test('outbox lockDueBatch with SKIP LOCKED returns disjoint batches to two concurrent callers');
test('isReversed true only for PROCESSED REFUND/ROLLBACK pointing to the id');
test('nudgeDependents sets next_attempt_at = now for PENDING_REFERENCE dependents only');
```

- [ ] **Step 2: Rodar** `bun test test/integration/persistence` → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(persistence): add MikroORM mappings, repositories and unit of work`

---

### Task 11: Use case OpenWallet

**Files:**
- Create: `src/application/use-cases/open-wallet.ts`
- Test: `test/integration/use-cases/open-wallet.test.ts`, `test/support/ledger-consistency.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `Clock`, `IdGenerator`, `Metrics`.
- Produces:
  - `class OpenWallet { constructor(uow, clock, ids, metrics); execute(input: { playerId: string; initialBalance: MoneyProps; correlationId: string }): Promise<{ id: string; playerId: string; balance: MoneyProps; version: number }> }` — lança `ApplicationError('WALLET_ALREADY_EXISTS')` para unique em `(player_id, currency)`; `ApplicationError('INVALID_PAYLOAD')` para `Money` inválido ou negativo.
  - `assertLedgerConsistency(sql: SQL, walletIds?: string[]): Promise<void>` — para cada wallet: `balance == Σcredit − Σdebit`, `balance == balance_after` do maior `wallet_version` (ou 0 sem lançamentos), versões contínuas começando em 1 ou 2, `count(entries) == version` (abertura > 0) ou `version − 1` (abertura 0).

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('opens with OPENING tx, CREDIT entry v1 and WalletBalanceChanged in outbox (same commit)');
test('opens with zero balance: no tx, no entry, no event, version 1');
test('duplicate player+currency → WALLET_ALREADY_EXISTS; same player other currency is fine');
test('20 parallel opens for same player+currency → exactly 1 success, 19 WALLET_ALREADY_EXISTS');
afterEach(() => assertLedgerConsistency(db.sql));
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat(application): add OpenWallet use case`

---

### Task 12: Use case SubmitWagerTransaction

**Files:**
- Create: `src/application/use-cases/submit-wager-transaction.ts`
- Test: `test/integration/use-cases/submit-wager-transaction.test.ts`, `test/integration/use-cases/atomicity.test.ts`

**Interfaces:**
- Consumes: ports, `settle`, eventos, `payloadHash`.
- Produces:
  - `interface SubmitResult { transactionId: string; status: WagerTransactionStatus; balance: MoneyProps; failureCode?: FailureCode; idempotentReplay: boolean }`
  - `class SubmitWagerTransaction { constructor(uow, clock, ids, faults: FaultInjector, metrics, jitter: () => number); execute(cmd: WagerCommand, source: SubmissionSource, correlationId: string): Promise<SubmitResult> }` — fluxo spec §6.1 exatamente, incluindo: `faults.hit('after_ledger_append')` logo após `ledger.append`, `faults.hit('before_commit')` no fim do callback; replay de mensagem SQS grava inbox; `UniqueViolationError` → uma reexecução completa; segunda violação propaga. Para `FAILED`: em erro não-classificado após validação, abre nova `uow.run` que trava a wallet e grava a transação como `FAILED` (`INTERNAL_PROCESSING_ERROR`), depois relança `PermanentInfraError`. Métricas: `transaction`, `duplicate`, `processingDuration`.
  - Validação de entrada lança `ApplicationError('INVALID_PAYLOAD')` (money inválido, `amount == 0.00`, `kind` OPENING, REFUND/ROLLBACK sem referência).

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('BET processed: balance, entry, outbox has Processed + WalletBalanceChanged');
test('LOSS processed: no entry, outbox has only WagerTransactionProcessed');
test('BET rejected INSUFFICIENT_FUNDS persisted with observed_balance; outbox has Rejected only');
test('replay returns original result with idempotentReplay true, including balance observed then', async () => {
  const first = await submit(bet('80.00')); await submit(win('5.00'));
  const again = await submit(bet('80.00'));
  expect(again).toEqual({ ...first, idempotentReplay: true }); // balance continua o observado na primeira vez
});
test('same key different payload → IDEMPOTENCY_KEY_REUSED, nothing written');
test('Review Focus #5: k1 then k2 for same provider+externalId → EXTERNAL_ID_CONFLICT; arbitrary key accepted first time');
test('wallet not found → WALLET_NOT_FOUND, nothing written');
test('ROLLBACK before BET → PENDING_REFERENCE + PendingReference event; BET arrival nudges it (next_attempt_at <= now)');
test('SQS source writes inbox; same messageId again → replay and duplicate metric; different hash → INBOX_PAYLOAD_MISMATCH');
test('SQS message for a tx first submitted via HTTP → replay and inbox written');
test('0.00 amount → INVALID_PAYLOAD');
test('same key with different walletId (unique race path) → resolves as IDEMPOTENCY_KEY_REUSED');
afterEach(() => assertLedgerConsistency(db.sql));
```

`atomicity.test.ts`:

```ts
test.each(['after_ledger_append', 'before_commit'])('throw at %s leaves no tx, entry, wallet change, outbox or inbox', ...)
test('unexpected error after validation records FAILED with INTERNAL_PROCESSING_ERROR and rethrows PermanentInfraError')
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(application): add SubmitWagerTransaction use case`

---

### Task 13: Consultas, ledger com cursor e reconciliação

**Files:**
- Create: `src/application/use-cases/{get-wallet.ts, list-ledger.ts, get-transaction.ts, reconcile-wallet.ts}`
- Test: `test/integration/use-cases/queries.test.ts`, `test/unit/application/ledger-cursor.test.ts`

**Interfaces:**
- Produces:
  - `GetWallet.execute(id): Promise<{ id; playerId; balance: MoneyProps; version: number }>` (`NOT_FOUND`).
  - `encodeLedgerCursor(v: number): string`, `decodeLedgerCursor(c: string): number` (base64url de `{"v":n}`; `n` inteiro ≥ 0, senão `ApplicationError('INVALID_CURSOR')`).
  - `ListLedger.execute(walletId, cursor?: string, limit = 50): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }>` — `limit` em `[1, 200]`, senão `INVALID_PAYLOAD`; `LedgerEntryView = { id; transactionId; direction; money; balanceBefore; balanceAfter; walletVersion; createdAt: string }`.
  - `GetTransaction.byId(id)` / `.byExternalId(providerId, externalId)` → `TransactionView = { id; providerId; externalTransactionId; walletId; playerId; roundId; gameId; kind; money; status; failureCode?; referenceExternalTransactionId?; referenceTransactionId?; observedBalance?; createdAt; processedAt? }`.
  - `ReconcileWallet.execute(walletId): Promise<{ walletId; storedBalance; calculatedBalance; difference; consistent: boolean; checkedEntries: number }>` — transação `REPEATABLE READ`; divergência → `logger.error` + `metrics.reconciliationMismatch()`; nunca escreve.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// unit
test.each(['', '!!!', btoa('{"v":-1}'), btoa('{"v":"2"}'), btoa('{"v":1.5}'), btoa('not json')])('Review Focus #4: rejects cursor %p', (c) =>
  expect(() => decodeLedgerCursor(c)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' })));
test('cursor roundtrip', () => expect(decodeLedgerCursor(encodeLedgerCursor(42))).toBe(42));
// integration
test('ledger paginates 120 entries with limit 50 into 50/50/20 then nextCursor null, no gaps or repeats');
test('cursor is stable while new entries are appended during pagination');
test('reconciliation consistent returns contract from README with checkedEntries');
test('reconciliation detects tampering (balance changed via superuser with triggers disabled) → consistent false, mismatch metric, wallet untouched');
test('get transaction by id and by provider external id; unknown → NOT_FOUND');
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat(application): add queries, ledger cursor pagination and reconciliation`

---

### Task 14: Observabilidade base + API HTTP

**Files:**
- Create: `src/infrastructure/observability/{logger.ts, request-context.ts, metrics.ts, health.ts}`, `src/infrastructure/auth/{noop-auth.guard.ts, noop-provider-identity.ts}`, `src/interfaces/http/**`, `src/main.api.ts`, `test/support/http.ts`
- Test: `test/integration/http/api.test.ts`, `test/unit/infrastructure/logger.test.ts`

**Interfaces:**
- Produces:
  - `createLogger(env): pino.Logger` — JSON, `redact` para `*.money`, `*.balance`, `*.amount`, `req.headers.authorization`, `req.body`; mixin com `requestContext` (`AsyncLocalStorage<{ correlationId; messageId?; transactionId?; walletId?; providerId? }>`).
  - `PromMetrics implements Metrics` (prom-client registry; nomes da spec §8); `GET /metrics`.
  - `HealthService.live()` → `{status:'ok'}`; `.ready()` → `SELECT 1` + `GetQueueAttributes(WAGER_QUEUE_URL)`; 503 se algum falhar.
  - `ProblemDetailsFilter` — mapeamento da spec §7; `ApplicationError` codes → status; `DomainError` não deve chegar aqui (use case converte); `TransientInfraError` → 503 + `Retry-After: 1`; demais → 500. Body `application/problem+json` `{ type: 'https://errors.wagering.local/<code-kebab>', title, status, code, retryable, correlationId }`.
  - `ZodValidationPipe` — falha → `ApplicationError('INVALID_PAYLOAD')`; schemas `strict()`; `walletId`/`playerId` `z.uuid()`; `money.amount` `z.string()` (parse de Money no use case).
  - Rotas (spec §6.6 e README §9): `POST /wallets` (201), `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wallets/:walletId/reconciliation` (200), `POST /wagering/transactions` (200/202/422 por `status` do resultado; `Idempotent-Replayed: true` quando replay), `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `GET /health/live`, `GET /health/ready`, `GET /metrics`. Path params UUID inválidos → 400 `INVALID_PAYLOAD`. `x-request-id` → `correlationId` (gera UUID v7 se ausente) e ecoa no response.
  - `NoopAuthGuard` global (pula `/health/*` e `/metrics`); `NoopProviderIdentity`.
  - `bootstrapApi(env): Promise<INestApplication>` em `src/main.api.ts` (`enableShutdownHooks`).

- [ ] **Step 1: Escrever os testes falhando** (`api.test.ts` sobe `bootstrapApi` com banco de teste):

```ts
test('POST /wallets 201 with README contract; duplicate 409 WALLET_ALREADY_EXISTS problem+json');
test('POST /wagering/transactions 200 PROCESSED with README response body');
test('replay → same status/body, idempotentReplay true, header Idempotent-Replayed');
test('rejected → 422 with transactionId, status REJECTED, failureCode, balance');
test('pending reference → 202');
test('missing Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY');
test('same key different payload → 409 IDEMPOTENCY_KEY_REUSED retryable false');
test('unknown wallet in body → 422 WALLET_NOT_FOUND');
test.each([
  ['malformed JSON', '{"providerId":'], ['numeric amount', { ...body, money: { amount: 25, currency: 'BRL' } }],
  ['non-uuid walletId', { ...body, walletId: 'abc' }], ['extra field', { ...body, foo: 1 }], ['OPENING kind', { ...body, kind: 'OPENING' }],
])('Review Focus #3: %s → 400 INVALID_PAYLOAD', ...);
test('GET /wallets/not-a-uuid → 400; unknown uuid → 404 NOT_FOUND');
test('ledger with bad cursor → 400 INVALID_CURSOR');
test('health live 200 without auth; ready 200 when db and sqs up');
test('metrics endpoint exposes wagering_transactions_total after a submit');
test('x-request-id is echoed and used as correlationId in outbox event');
```

`logger.test.ts`: log de um objeto com `money`/`balance`/`authorization` sai com `[Redacted]` e inclui `correlationId` do contexto.

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(http): add REST API, problem details, logging, metrics and health`

---

### Task 15: Consumer SQS

**Files:**
- Create: `src/infrastructure/sqs/sqs-client.ts`, `src/interfaces/sqs/{wager-message.schema.ts, consumer-decision.ts, wager-transaction.consumer.ts, consumer.module.ts}`, `src/interfaces/ops-http.ts`, `src/main.consumer.ts`, `test/support/sqs.ts`
- Test: `test/unit/interfaces/consumer-decision.test.ts`, `test/integration/sqs/consumer.test.ts`

**Interfaces:**
- Consumes: `SubmitWagerTransaction`, `Metrics`, logger, `FaultInjector`.
- Produces:
  - `createSqsClient(env): SQSClient`.
  - `wagerMessageSchema` (zod, README §10; `type` literal `WagerTransactionRequested`).
  - `type ConsumerDecision = { action: 'ack' } | { action: 'dlq'; reason: string } | { action: 'retry'; delaySeconds: number }`
  - `decide(outcome: { ok: true } | { ok: false; error: unknown }, receiveCount: number, jitter: () => number): ConsumerDecision` — `ok` → ack; `ApplicationError` (`INVALID_PAYLOAD`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT`, `INBOX_PAYLOAD_MISMATCH`) → dlq com `reason = code`; `PermanentInfraError` → dlq `INTERNAL_PROCESSING_ERROR`; `TransientInfraError` → retry com `delaySeconds = ceil(backoffDelayMs(receiveCount - 1, { ...CONSUMER_BACKOFF, jitter })/1000)` limitado a 43200; outro erro → retry.
  - `class WagerTransactionConsumer { start(): void; stop(): Promise<void>; handle(m: Message): Promise<ConsumerDecision> }` — `ReceiveMessage` (`WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, `VisibilityTimeout=SQS_VISIBILITY_TIMEOUT_S`, `MessageSystemAttributeNames=['ApproximateReceiveCount']`); executa mensagens do lote concorrentemente; `faults.hit('after_commit_before_ack')` entre o use case e o `DeleteMessage`; dlq = `metrics.dlq(reason)` + `SendMessage` para DLQ com `MessageAttributes.reason`, `MessageGroupId` original e `MessageDeduplicationId = messageId` + `DeleteMessage`; retry = `metrics.retry('consumer')` + `ChangeMessageVisibility(delaySeconds)`. `stop()`: para o loop, aguarda em voo até `SHUTDOWN_GRACE_MS`, depois `ChangeMessageVisibility(0)` nos restantes. JSON inválido → dlq `INVALID_PAYLOAD` com `messageId` = `MessageId` do SQS. Contexto de log por mensagem.
  - `startOpsHttp(port, health, metrics): Server` — `/health/live`, `/health/ready`, `/metrics` via `Bun.serve`.
  - `test/support/sqs.ts`: `createTestQueues(sqs, prefix): Promise<{ queueUrl; dlqUrl; eventsUrl; destroy() }>` (mesma redrive com `maxReceiveCount` parametrizável), `sendWagerMessage(sqs, queueUrl, data, opts?)`, `receiveAll(sqs, queueUrl, { waitMs })`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// unit
test('business outcome → ack'); test.each(['INVALID_PAYLOAD','WALLET_NOT_FOUND','IDEMPOTENCY_KEY_REUSED'])('%s → dlq with reason');
test('transient → retry with exponential delay by receiveCount (1,2,4,8…, cap 60)'); test('PermanentInfraError → dlq INTERNAL_PROCESSING_ERROR');
// integration (filas com prefixo, visibility 2s)
test('valid BET message processed, acked, inbox row written, queue empty');
test('duplicated message (two sends, different SQS MessageId, same messageId) → one debit, duplicate metric');
test('invalid JSON goes to DLQ with reason attribute and is deleted from main queue');
test('transient failure (FAULT=before_commit:throw mapped as transient) retries until success without duplicating');
test('repeated transient failures reach DLQ through redrive after maxReceiveCount');
test('stop() during in-flight message completes it; unprocessed messages become visible immediately');
afterEach(() => assertLedgerConsistency(db.sql));
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(sqs): add wager transaction consumer with inbox, retry and DLQ`

---

### Task 16: Outbox publisher

**Files:**
- Create: `src/infrastructure/sqs/sqs-event-publisher.ts`, `src/application/use-cases/publish-outbox.ts`, `src/interfaces/workers/outbox-publisher.worker.ts`
- Test: `test/integration/workers/outbox-publisher.test.ts`

**Interfaces:**
- Produces:
  - `SqsEventPublisher implements EventPublisher` — `SendMessageBatch` em blocos de 10 para `EVENTS_QUEUE_URL`; `MessageBody = JSON.stringify(payload)`, `MessageGroupId = aggregateId`, `MessageDeduplicationId = id`; retorna ids publicados/falhos.
  - `PublishOutbox.execute(batchSize): Promise<{ published: number; retried: number }>` — dentro de `uow.run`: `lockDueBatch` → `publishBatch` → `faults.hit('after_publish_before_mark')` → `markPublished`/`scheduleRetry` + `save`; atualiza `setOutboxLag`/`setOutboxPending`; `retry('outbox')` por falha.
  - `OutboxPublisherWorker { start(); stop(): Promise<void> }` — loop: executa; se `published + retried === 0`, espera `OUTBOX_POLL_MS`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('publishes pending events with envelope and marks them published');
test('SQS failure schedules retry with backoff and keeps event pending');
test('two concurrent publishers (separate ORMs) publish 500 events: every eventId received ≥ 1 time, all marked published');
test('crash after publish before mark (FAULT throw) → event republished by next run; consumer-side dedup by eventId yields 500 unique');
test('process holding the batch dies (connection closed) → another publisher takes over');
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat(workers): add transactional outbox publisher`

---

### Task 17: Worker de PENDING_REFERENCE e entrypoint `workers`

**Files:**
- Create: `src/application/use-cases/retry-pending-references.ts`, `src/interfaces/workers/{pending-reference.worker.ts, workers.module.ts}`, `src/main.workers.ts`
- Test: `test/integration/workers/pending-reference.test.ts`

**Interfaces:**
- Produces:
  - `interface PendingReferencePolicy { maxAttempts: number; ttlMs: number; backoff: BackoffPolicy }`
  - `RetryPendingReferences.execute(limit): Promise<{ resolved: number; rescheduled: number; expired: number }>` — spec §6.4: candidatos sem lock; por candidato `uow.run` → `wallets.lockById` → `transactions.lockById` → se não `PENDING_REFERENCE` ou não vencida, pula; expira se `attempts + 1 >= maxAttempts` **ou** `now − createdAt >= ttlMs` → `reject(REFERENCE_NOT_FOUND)` + `WagerTransactionRejected`; senão `settle` com `pendingRetryAt = computeNextAttemptAt(now, attempts + 1, backoff)`; resolvido gera os mesmos eventos do submit. `setPendingReferences` atualizado.
  - `main.workers.ts` sobe `OutboxPublisherWorker` + `PendingReferenceWorker` + `startOpsHttp`; `SIGTERM` → `stop()` dos dois.

- [ ] **Step 1: Escrever os testes falhando**

```ts
test('ROLLBACK pending, BET arrives → worker resolves ROLLBACK, balance back, events emitted');
test('REFUND pending with no reference → rescheduled with backoff; after maxAttempts → REJECTED REFERENCE_NOT_FOUND + Rejected event');
test('TTL exceeded (clock advanced) → REJECTED REFERENCE_NOT_FOUND even with attempts left');
test('two workers on the same candidates resolve each exactly once');
test('worker and submit on the same wallet do not deadlock (100 iterations interleaved)');
afterEach(() => assertLedgerConsistency(db.sql));
```

- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS + typecheck.
- [ ] **Step 5: Commit** — `feat(workers): add pending reference retry worker and workers entrypoint`

---

### Task 18: Dockerfile e Compose da aplicação

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yml`, `.env.example` (completar)
- Test: `test/integration/runtime/compose-smoke.test.ts`

**Interfaces:**
- Produces: imagem `oven/bun:1.4` multi-stage (`bun install --frozen-lockfile --production`), comando por serviço: `migrate` → `bun src/main.migrate.ts up`; `api` → `bun src/main.api.ts` (porta 3000); `consumer` → `bun src/main.consumer.ts` (ops 3001); `workers` → `bun src/main.workers.ts` (ops 3002). `depends_on` com `condition: service_healthy` (infra) e `service_completed_successfully` (`migrate`). Healthcheck `GET /health/ready` em cada serviço. `consumer` e `workers` sem porta publicada no host (escaláveis).

- [ ] **Step 1: Escrever o teste falhando** — `compose-smoke.test.ts` (gated por `E2E_COMPOSE=1`, roda no Task 20 e manualmente aqui): `docker compose up -d --build --scale consumer=3 --scale workers=2 --wait` → `GET localhost:3000/health/ready` 200 e `docker compose ps --format json` mostra 3 consumers e 2 workers `healthy`.
- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS; `docker compose down -v`.
- [ ] **Step 5: Commit** — `build: add Dockerfile and compose stack for api, consumer and workers`

---

### Task 19: Suíte de concorrência (8 cenários obrigatórios)

**Files:**
- Create: `test/support/processes.ts`, `test/concurrency/{01-same-bet-50x,02-hot-wallet-race,03-parallel-wallets,04-multi-instance,05-crash-after-commit,06-concurrent-publishers,07-reference-before-target,08-restart-recovery}.test.ts`

**Interfaces:**
- Produces: `spawnService(role: 'api' | 'consumer' | 'workers', env: Record<string,string>): Promise<ServiceHandle>` — `Bun.spawn(['bun', `src/main.${role}.ts`])`, espera `/health/ready`; `ServiceHandle { port: number; proc: Subprocess; kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<number> }`. Porta livre escolhida pelo helper. Cada arquivo usa banco e filas próprios.

- [ ] **Step 1: Escrever os 8 testes** (cada um termina com `assertLedgerConsistency`):

```ts
// 01: 1 api; 50 POST idênticos com Promise.all → 1 status 200 non-replay + 49 replays; 1 linha DEBIT; saldo = inicial − valor
// 02: wallet 100.00; 2 BET 80.00 simultâneos via 2 processos api → exatamente 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00, 1 DEBIT; reenviar ambos → replays, ainda 1 DEBIT
// 03: 20 wallets × 25 BETs paralelos; tempo total < 50% do tempo de 1 wallet × 500 BETs medido no mesmo teste
// 04: 3 api + 3 consumer; 10 wallets; 600 operações mistas (metade HTTP, metade SQS com duplicatas) → todas terminais, nenhum saldo negativo
// 05: consumer com FAULT=after_commit_before_ack:crash e visibility 2s → processo sai 137; sobe consumer sem fault → mensagem reprocessada como replay; 1 efeito; fila vazia
// 06: 500 eventos na outbox; 2 processos workers → todos publicados; eventIds únicos lidos da fila == 500
// 07: ROLLBACK via SQS antes da BET; depois BET via SQS; workers rodando → ambos PROCESSED, saldo igual ao inicial, eventos PendingReference + Processed×2
// 08: carga contínua (api + 3 consumers + 2 workers); SIGKILL em todos no meio; restart; eventually: fila vazia, outbox vazia, sem PENDING vencidos; reconciliação consistente em todas as wallets
```

- [ ] **Step 2: Rodar** `bun run test:concurrency` → os que dependem de bug real falham; corrigir o código de produção pelo fluxo de systematic-debugging (nunca relaxar o teste).
- [ ] **Step 3: Rodar 3× seguidas** → PASS nas 3 (detecta flakiness).
- [ ] **Step 4: Commit** — `test: add real-parallelism concurrency suite for mandatory scenarios`

---

### Task 20: E2E contra a stack Docker

**Files:**
- Create: `test/e2e/{journey-http,idempotency,journey-sqs,out-of-order,poison-message,health,scale}.test.ts`, `test/e2e/setup.ts`
- Modify: `package.json` (`test:e2e` = `docker compose up -d --build --scale consumer=3 --scale workers=2 --wait && E2E_COMPOSE=1 bun test test/e2e test/integration/runtime; docker compose down -v`)

**Interfaces:**
- Consumes: só HTTP (`localhost:3000`) e SQS (LocalStack `localhost:4566`). Nenhum acesso ao banco, exceto `docker compose stop/start postgres` no teste de health.

- [ ] **Step 1: Escrever os testes** — cenários 1–7 da spec §10.1 E2E; cada arquivo termina reconciliando todas as wallets que criou via `POST /wallets/:id/reconciliation` e esperando `consistent: true`.
- [ ] **Step 2: Rodar** `bun run test:e2e` → PASS (corrigir produção se falhar).
- [ ] **Step 3: Rodar `bun run test` completo** → typecheck, unit, integration, concurrency, e2e todos PASS.
- [ ] **Step 4: Commit** — `test: add end-to-end suite against the compose stack`

---

### Task 21: README.md e ARCHITECTURE.md

**Files:**
- Create: `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1: README.md** — pré-requisitos (Bun 1.4, Docker), `bun install`, `docker compose up --build --scale consumer=3 --scale workers=2`, exemplos `curl` de cada endpoint, como publicar mensagem no SQS com `awslocal`, todos os scripts de teste e o que cada um sobe, variáveis de ambiente (tabela de `loadEnv`).
- [ ] **Step 2: ARCHITECTURE.md** — camadas e regra de dependência; por que MikroORM 7 + `defineEntity` e mapeamento de `Money` (`bigint` ↔ `numeric(20,2)` via string); estratégia transacional (`UnitOfWork`, ordem de lock, `lock_timeout`); por que pessimista vs optimistic; idempotência (hash canônico: algoritmo e campos, inbox, replay com `observed_balance`); schema e cada constraint/trigger; máquina de estados e transições; taxonomia de `failureCode` e mapeamento HTTP; consumer (classificação, backoff, DLQ, shutdown); outbox (SKIP LOCKED, trade-off do lock durante publish vs lease); pending reference (limites e justificativa); observabilidade; autenticação (decisão + desenho Keycloak); as 7 interpretações da spec §11 + `BALANCE_LIMIT_EXCEEDED`; limitações §12.
- [ ] **Step 3: Conferir** que todo comando do README roda como descrito numa cópia limpa (`git clone` em diretório temporário).
- [ ] **Step 4: Commit** — `docs: add README and ARCHITECTURE`

---

### Task 22: Testes de carga e relatório

**Files:**
- Create: `compose.load.yml`, `test/load/k6/{distributed,hot-wallet,duplicates,sqs-drain,soak}.js`, `test/load/k6/lib/{seed.js, payloads.js}`, `test/load/run.ts`, `docs/load-test-report.md`
- Modify: `package.json` (`test:load` = `bun test/load/run.ts`)

**Interfaces:**
- Produces: `bun run test:load [--scenario <name>] [--consumers N]`: sobe `compose.yml` + `compose.load.yml` (`cpus`/`mem_limit` fixos: api 2 CPU/1GB, consumer 1 CPU/512MB, workers 1 CPU/512MB, postgres 2 CPU/2GB), semeia wallets via API, roda `grafana/k6` em container na rede do compose com `--summary-export`, coleta `/metrics` antes/depois e `pg_stat_activity` amostrado, reconcilia todas as wallets e falha se alguma `consistent: false`; grava `test/load/results/<timestamp>/{scenario}.json` e `summary.md`.
- k6 thresholds de correção: `checks{type:correctness} == 1.0`, `http_req_failed{expected_response:true} < 0.01` (exceto 422 esperados). Cenários conforme spec §10.2 (distribuído: `ramping-arrival-rate` 50→800 req/s em 5 min; hot wallet: 10 wallets, 200 req/s; duplicatas: 30% reenvio; drain: 50k mensagens via `k6-jslib-aws` SQSClient com versão fixa, medido com `--consumers 1` e `3`; soak: 15 min a 50% da capacidade medida).

- [ ] **Step 1: Implementar `run.ts` e o cenário `hot-wallet`; rodar** → relatório gerado e reconciliação OK.
- [ ] **Step 2: Implementar os outros 4 cenários; rodar todos.**
- [ ] **Step 3: Escrever `docs/load-test-report.md`** — ambiente (máquina, CPU, RAM, Docker, limites, versões), metodologia, tabela por cenário (RPS sustentado, p50/p95/p99, taxa de erro por status, `db_lock_conflicts_total`, retries, outbox lag máximo, tempo de drenagem 1 vs 3 consumers), gargalos observados, o que mudaria para escalar, limitações (LocalStack, máquina única).
- [ ] **Step 4: Commit** — `test: add k6 load test scenarios and report`

---

### Task 23: Keycloak (opcional — só com `bun run test` verde)

**Files:**
- Create: `infra/keycloak/realm-wagering.json`, `src/infrastructure/auth/keycloak-jwt.guard.ts`, `src/infrastructure/auth/jwt-provider-identity.ts`
- Modify: `compose.yml` (serviço `keycloak` em profile `auth`), `src/interfaces/http/app.module.ts` (guard por `AUTH_MODE`), `.env.example`, `README.md`, `ARCHITECTURE.md`
- Test: `test/integration/http/auth.test.ts` (gated por `AUTH_E2E=1`)

**Interfaces:**
- Produces: `KeycloakJwtGuard` com `jose` `createRemoteJWKSet(KEYCLOAK_JWKS_URL)` validando `iss = KEYCLOAK_ISSUER`, `aud = 'wagering-api'`; `principal.providerId = payload.azp`; `JwtProviderIdentity.assertMayActAs` lança `ForbiddenProviderError` (→ 403 `PROVIDER_MISMATCH`). Realm com clients `provider-a`, `provider-b` (client credentials, secrets só de teste no realm export).

- [ ] **Step 1: Escrever os testes falhando** — sem token → 401; token `provider-a` + body `providerId: provider-b` → 403 `PROVIDER_MISMATCH`; token `provider-a` + body `provider-a` → 200; `/health/*` sem token → 200.
- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** com `docker compose --profile auth up` → PASS; `bun run test` (com `AUTH_MODE=none`) continua verde.
- [ ] **Step 5: Commit** — `feat(auth): add optional Keycloak JWT guard`
