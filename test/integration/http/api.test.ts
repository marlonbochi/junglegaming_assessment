import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfraError } from '../../../src/application/errors';
import type { FaultInjector, FaultPoint } from '../../../src/application/ports/fault-injector';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { call, startTestApi, type TestApi } from '../../support/http';
import { newId } from '../../support/persistence';

let db: TestDatabase;
let api: TestApi;
const logLines: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  db = await createTestDatabase();
  const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line: string) => void logLines.push(JSON.parse(line)) });
  api = await startTestApi(db.url, { overrides: { logger } });
});

afterEach(() => assertLedgerConsistency(db.sql));

afterAll(async () => {
  await api?.close();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface WalletJson {
  id: string;
  playerId: string;
}

async function openWallet(amount = '100.00', target: TestApi = api): Promise<WalletJson> {
  const res = await call(target, 'POST', '/wallets', { body: { playerId: newId(), initialBalance: brl(amount) } });
  expect(res.status).toBe(201);
  return res.body;
}

function wagerBody(wallet: WalletJson, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

/** `key: null` sends no Idempotency-Key header. */
const submit = (body: unknown, key: string | null = `key-${newId()}`, headers: Record<string, string> = {}, target = api) =>
  call(target, 'POST', '/wagering/transactions', {
    body,
    headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...headers },
  });

function expectProblem(res: { status: number; headers: Headers; body: any }, status: number, code: string, retryable = false) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toStartWith('application/problem+json');
  expect(res.body).toMatchObject({
    type: `https://errors.wagering.local/${code.toLowerCase().replaceAll('_', '-')}`,
    title: expect.any(String),
    status,
    code,
    retryable,
    correlationId: res.headers.get('x-request-id'),
  });
}

describe('wallets', () => {
  test('POST /wallets 201 with README contract; duplicate 409 WALLET_ALREADY_EXISTS problem+json', async () => {
    const playerId = newId();
    const created = await call(api, 'POST', '/wallets', { body: { playerId, initialBalance: brl('100.00') } });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), playerId, balance: brl('100.00'), version: 1 });

    const duplicate = await call(api, 'POST', '/wallets', { body: { playerId, initialBalance: brl('5.00') } });
    expectProblem(duplicate, 409, 'WALLET_ALREADY_EXISTS');
  });

  test('POST /wallets with an invalid amount → 400 INVALID_PAYLOAD', async () => {
    const res = await call(api, 'POST', '/wallets', { body: { playerId: newId(), initialBalance: brl('1.5') } });
    expectProblem(res, 400, 'INVALID_PAYLOAD');
  });

  test('GET /wallets/:id returns the wallet', async () => {
    const wallet = await openWallet('42.00');
    const res = await call(api, 'GET', `/wallets/${wallet.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: brl('42.00'), version: 1 });
  });

  test('GET /wallets/not-a-uuid → 400; unknown uuid → 404 NOT_FOUND', async () => {
    expectProblem(await call(api, 'GET', '/wallets/not-a-uuid'), 400, 'INVALID_PAYLOAD');
    expectProblem(await call(api, 'GET', `/wallets/${newId()}`), 404, 'NOT_FOUND');
  });

  test('ledger pages ascending by wallet version with a cursor', async () => {
    const wallet = await openWallet();
    await submit(wagerBody(wallet));
    const first = await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({ direction: 'CREDIT', money: brl('100.00'), walletVersion: 1 });

    const second = await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0]).toMatchObject({ direction: 'DEBIT', money: brl('25.00'), balanceAfter: brl('75.00'), walletVersion: 2 });
    expect(second.body.nextCursor).toBeNull();
  });

  test('ledger with bad cursor → 400 INVALID_CURSOR; bad limit → 400 INVALID_PAYLOAD', async () => {
    const wallet = await openWallet();
    expectProblem(await call(api, 'GET', `/wallets/${wallet.id}/ledger?cursor=!!!`), 400, 'INVALID_CURSOR');
    expectProblem(await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=abc`), 400, 'INVALID_PAYLOAD');
    expectProblem(await call(api, 'GET', `/wallets/${wallet.id}/ledger?limit=201`), 400, 'INVALID_PAYLOAD');
  });

  test('POST /wallets/:id/reconciliation → 200 with the README contract', async () => {
    const wallet = await openWallet();
    await submit(wagerBody(wallet));
    const res = await call(api, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('uuid case normalization', () => {
  test('uppercase ids are accepted, normalized to lowercase and treated as the same logical request', async () => {
    const playerId = newId();
    const created = await call(api, 'POST', '/wallets', { body: { playerId: playerId.toUpperCase(), initialBalance: brl('100.00') } });
    expect(created.status).toBe(201);
    expect(created.body.playerId).toBe(playerId);

    const wallet = created.body as WalletJson;
    const upper = wagerBody(wallet, { playerId: wallet.playerId.toUpperCase(), walletId: wallet.id.toUpperCase() });
    const first = await submit(upper, 'case-key-1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const replay = await submit({ ...upper, playerId: wallet.playerId, walletId: wallet.id }, 'case-key-1');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const got = await call(api, 'GET', `/wallets/${wallet.id.toUpperCase()}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(wallet.id);
  });
});

describe('wager transactions', () => {
  test('POST /wagering/transactions 200 PROCESSED with README response body', async () => {
    const wallet = await openWallet();
    const res = await submit(wagerBody(wallet));
    expect(res.status).toBe(200);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false });
  });

  test('replay → same status/body, idempotentReplay true, header Idempotent-Replayed', async () => {
    const wallet = await openWallet();
    const body = wagerBody(wallet);
    const first = await submit(body, 'replay-key-1');
    const replay = await submit(body, 'replay-key-1');
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  test('rejected → 422 with transactionId, status REJECTED, failureCode, balance', async () => {
    const wallet = await openWallet('10.00');
    const res = await submit(wagerBody(wallet, { money: brl('25.00') }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
      idempotentReplay: false,
    });
  });

  test('pending reference → 202', async () => {
    const wallet = await openWallet();
    const res = await submit(wagerBody(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `missing-${newId()}` }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false });
  });

  test('GET by id and by provider external id return the transaction', async () => {
    const wallet = await openWallet();
    const body = wagerBody(wallet);
    const { body: result } = await submit(body);
    const byId = await call(api, 'GET', `/wagering/transactions/${result.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: result.transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      observedBalance: brl('75.00'),
    });
    const byExternal = await call(api, 'GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);

    expectProblem(await call(api, 'GET', '/wagering/transactions/123'), 400, 'INVALID_PAYLOAD');
    expectProblem(await call(api, 'GET', `/wagering/transactions/${newId()}`), 404, 'NOT_FOUND');
    expectProblem(await call(api, 'GET', '/providers/provider-a/wagering/transactions/nope'), 404, 'NOT_FOUND');
  });

  test.each([
    ['missing', null],
    ['empty', ''],
    ['longer than 255 chars', 'k'.repeat(256)],
  ])('Idempotency-Key %s → 400 MISSING_IDEMPOTENCY_KEY', async (_name, key) => {
    const wallet = await openWallet();
    expectProblem(await submit(wagerBody(wallet), key), 400, 'MISSING_IDEMPOTENCY_KEY');
  });

  test('same key different payload → 409 IDEMPOTENCY_KEY_REUSED retryable false', async () => {
    const wallet = await openWallet();
    await submit(wagerBody(wallet), 'reused-key');
    expectProblem(await submit(wagerBody(wallet, { money: brl('1.00') }), 'reused-key'), 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('same external id under another key → 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await openWallet();
    const body = wagerBody(wallet);
    await submit(body);
    expectProblem(await submit(body), 409, 'EXTERNAL_ID_CONFLICT');
  });

  test('unknown wallet in body → 422 WALLET_NOT_FOUND', async () => {
    const res = await submit(wagerBody({ id: newId(), playerId: newId() }));
    expectProblem(res, 422, 'WALLET_NOT_FOUND');
  });

  describe('Review Focus #3: invalid payloads never reach the database', () => {
    const valid = { id: '00000000-0000-7000-8000-000000000000', playerId: '00000000-0000-7000-8000-000000000001' };
    const base = () => wagerBody(valid);
    test.each<[string, unknown]>([
      ['malformed JSON', '{"providerId":'],
      ['numeric amount', { ...base(), money: { amount: 25, currency: 'BRL' } }],
      ['amount with 3 decimals', { ...base(), money: brl('25.000') }],
      ['zero amount', { ...base(), money: brl('0.00') }],
      ['non-uuid walletId', { ...base(), walletId: 'abc' }],
      ['non-uuid playerId', { ...base(), playerId: 'abc' }],
      ['extra field', { ...base(), foo: 1 }],
      ['extra money field', { ...base(), money: { ...brl('1.00'), scale: 2 } }],
      ['OPENING kind', { ...base(), kind: 'OPENING' }],
      ['missing roundId', { ...base(), roundId: undefined }],
      ['ROLLBACK without reference', { ...base(), kind: 'ROLLBACK' }],
      ['array body', [base()]],
    ])('%s → 400 INVALID_PAYLOAD', async (_name, body) => {
      expectProblem(await submit(body), 400, 'INVALID_PAYLOAD');
    });

    test('non-JSON content type → 400 INVALID_PAYLOAD', async () => {
      const res = await call(api, 'POST', '/wagering/transactions', {
        body: JSON.stringify(base()),
        headers: { 'content-type': 'text/plain', 'idempotency-key': `key-${newId()}` },
      });
      expectProblem(res, 400, 'INVALID_PAYLOAD');
    });
  });
});

describe('cross-cutting', () => {
  test('unknown route → 404 NOT_FOUND problem+json', async () => {
    expectProblem(await call(api, 'GET', '/nope'), 404, 'NOT_FOUND');
  });

  test('health live 200 without auth; ready 200 when db and sqs up', async () => {
    const live = await call(api, 'GET', '/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await call(api, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'up', queue: 'up' } });
  });

  test('metrics endpoint exposes wagering_transactions_total after a submit', async () => {
    const wallet = await openWallet();
    await submit(wagerBody(wallet, { kind: 'WIN', money: brl('3.00') }));
    const res = await call(api, 'GET', '/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toStartWith('text/plain');
    expect(res.body).toContain('wagering_transactions_total{status="PROCESSED",kind="WIN",source="http"} 1');
    expect(res.body).toContain('wagering_processing_duration_seconds_count{source="http"}');
  });

  test('x-request-id is echoed and used as correlationId in outbox event', async () => {
    const wallet = await openWallet();
    const res = await submit(wagerBody(wallet), undefined, { 'x-request-id': 'corr-http-1' });
    expect(res.headers.get('x-request-id')).toBe('corr-http-1');
    const rows = await db.sql`
      SELECT DISTINCT payload->>'correlationId' AS correlation_id FROM outbox_messages
       WHERE payload->>'causationId' = ${res.body.transactionId}`;
    expect(rows).toEqual([{ correlation_id: 'corr-http-1' }]);
  });

  test('without x-request-id a UUID v7 correlationId is generated and echoed in problems', async () => {
    const res = await call(api, 'GET', `/wallets/${newId()}`);
    const generated = res.headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.body.correlationId).toBe(generated);
  });

  test('one access log line per request, with route and no body or money', async () => {
    const wallet = await openWallet();
    await submit(wagerBody(wallet), undefined, { 'x-request-id': 'corr-access-log' });
    const lines = logLines.filter((l) => l.correlationId === 'corr-access-log');
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'request completed',
        method: 'POST',
        route: '/wagering/transactions',
        status: 200,
        durationMs: expect.any(Number),
        walletId: wallet.id,
        providerId: 'provider-a',
        transactionId: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('25.00');
  });
});

describe('infrastructure failures', () => {
  let faulty: TestApi;
  let failWith: { point: FaultPoint; error: () => Error } | undefined;
  const faults: FaultInjector = {
    hit(point) {
      if (failWith?.point === point) throw failWith.error();
    },
  };

  beforeAll(async () => {
    faulty = await startTestApi(db.url, {
      env: { WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/does-not-exist.fifo' },
      overrides: { faults },
    });
  });

  afterEach(() => {
    failWith = undefined;
  });

  afterAll(() => faulty?.close());

  test('ready 503 when the queue is unreachable', async () => {
    const ready = await call(faulty, 'GET', '/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'error', checks: { database: 'up', queue: 'down' } });
  });

  test('TransientInfraError → 503 SERVICE_UNAVAILABLE retryable with Retry-After, nothing persisted', async () => {
    const wallet = await openWallet('100.00', faulty);
    failWith = { point: 'before_commit', error: () => new TransientInfraError('db hiccup') };
    const res = await submit(wagerBody(wallet), undefined, {}, faulty);
    expectProblem(res, 503, 'SERVICE_UNAVAILABLE', true);
    expect(res.headers.get('retry-after')).toBe('1');
    const [row] = await db.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
    expect(row.n).toBe(0);
  });

  test('unexpected error → 500 INTERNAL_ERROR retryable; its replay → 500 terminal FAILED, not retryable', async () => {
    const wallet = await openWallet('100.00', faulty);
    const body = wagerBody(wallet);
    failWith = { point: 'after_ledger_append', error: () => new Error('bug') };
    const first = await submit(body, 'failed-key', {}, faulty);
    expectProblem(first, 500, 'INTERNAL_ERROR', true);
    expect(JSON.stringify(first.body)).not.toContain('bug');

    failWith = undefined;
    const replay = await submit(body, 'failed-key', {}, faulty);
    expectProblem(replay, 500, 'INTERNAL_ERROR', false);
    expect(replay.body.transactionId).toEqual(expect.any(String));
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });
});
