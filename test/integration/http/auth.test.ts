import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../support/db';
import { call, startTestApi, type TestApi } from '../../support/http';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { newId } from '../../support/persistence';

/**
 * Spec §9 optional auth against a real Keycloak (`docker compose --profile auth up -d --wait keycloak`, or
 * `bun run test:auth`). Skipped unless AUTH_E2E=1, so `bun run test` keeps running with AUTH_MODE=none.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const REALM_URL = `${KEYCLOAK_URL}/realms/wagering`;

/** Test-only client secrets from infra/keycloak/realm-wagering.json. */
async function tokenFor(clientId: 'provider-a' | 'provider-b' | 'other-service'): Promise<string> {
  const res = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: `${clientId}-test-secret` }),
  });
  if (!res.ok) throw new Error(`token for ${clientId} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

describe.skipIf(process.env.AUTH_E2E !== '1')('Keycloak JWT auth (AUTH_MODE=keycloak)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let tokenA: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    api = await startTestApi(db.url, {
      env: {
        AUTH_MODE: 'keycloak',
        KEYCLOAK_ISSUER: REALM_URL,
        KEYCLOAK_JWKS_URL: `${REALM_URL}/protocol/openid-connect/certs`,
      },
    });
    tokenA = await tokenFor('provider-a');
  });

  afterEach(() => assertLedgerConsistency(db.sql));

  afterAll(async () => {
    await api?.close();
    await db?.drop();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function openWallet(token: string): Promise<{ id: string; playerId: string }> {
    const res = await call(api, 'POST', '/wallets', {
      body: { playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      headers: bearer(token),
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  function submitAs(providerId: string, wallet: { id: string; playerId: string }, headers: Record<string, string>) {
    return call(api, 'POST', '/wagering/transactions', {
      body: {
        providerId,
        externalTransactionId: `ext-${newId()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      headers: { 'idempotency-key': `key-${newId()}`, ...headers },
    });
  }

  function expectProblem(res: { status: number; headers: Headers; body: any }, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toStartWith('application/problem+json');
    expect(res.body).toMatchObject({ status, code, retryable: false, correlationId: res.headers.get('x-request-id') });
  }

  test('no token → 401 UNAUTHENTICATED problem+json with WWW-Authenticate: Bearer', async () => {
    const wallet = await openWallet(tokenA);
    const res = await submitAs('provider-a', wallet, {});
    expectProblem(res, 401, 'UNAUTHENTICATED');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expectProblem(await call(api, 'GET', `/wallets/${wallet.id}`), 401, 'UNAUTHENTICATED');
  });

  test('garbage token and a token without the wagering-api audience → 401', async () => {
    const wallet = await openWallet(tokenA);
    expectProblem(await submitAs('provider-a', wallet, bearer('not-a-jwt')), 401, 'UNAUTHENTICATED');
    expectProblem(await submitAs('other-service', wallet, bearer(await tokenFor('other-service'))), 401, 'UNAUTHENTICATED');
  });

  test('provider-a token submitting as provider-b → 403 PROVIDER_MISMATCH, nothing recorded', async () => {
    const wallet = await openWallet(tokenA);
    expectProblem(await submitAs('provider-b', wallet, bearer(tokenA)), 403, 'PROVIDER_MISMATCH');
    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
    expect(count).toBe(0);
  });

  test('provider-a token submitting as provider-a → 200 PROCESSED', async () => {
    const wallet = await openWallet(tokenA);
    const res = await submitAs('provider-a', wallet, bearer(tokenA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
  });

  test('provider-b token works for provider-b (one client per provider)', async () => {
    const wallet = await openWallet(tokenA);
    expect((await submitAs('provider-b', wallet, bearer(await tokenFor('provider-b')))).status).toBe(200);
  });

  test('/health/* and /metrics need no token', async () => {
    expect((await call(api, 'GET', '/health/live')).status).toBe(200);
    expect((await call(api, 'GET', '/health/ready')).status).toBe(200);
    expect((await call(api, 'GET', '/metrics')).status).toBe(200);
  });
});
