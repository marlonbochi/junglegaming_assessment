import { beforeAll, describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { TransientInfraError, UnauthenticatedError } from '../../../src/application/errors';
import { KeycloakJwtGuard, WAGERING_API_AUDIENCE } from '../../../src/infrastructure/auth/keycloak-jwt.guard';

const ISSUER = 'http://localhost:8080/realms/wagering';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let trusted: KeyPair;
let untrusted: KeyPair;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  trusted = await generateKeyPair('RS256');
  untrusted = await generateKeyPair('RS256');
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(trusted.publicKey)), kid: 'k1', alg: 'RS256' }] });
});

interface FakeRequest {
  path: string;
  headers: Record<string, string>;
  principal?: unknown;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

interface TokenOpts {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string | null;
  expiresAt?: number | string;
  key?: KeyPair;
}

function token(opts: TokenOpts = {}) {
  const { claims = { azp: 'provider-a' }, issuer = ISSUER, audience = WAGERING_API_AUDIENCE, expiresAt = '5m', key = trusted } = opts;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setSubject('svc-1')
    .setIssuedAt()
    .setExpirationTime(expiresAt);
  if (audience !== null) jwt.setAudience(audience);
  return jwt.sign(key.privateKey);
}

async function authenticate(authorization: string | undefined, path = '/wagering/transactions', getKey: JWTVerifyGetKey = keys) {
  const request: FakeRequest = { path, headers: authorization === undefined ? {} : { authorization } };
  const allowed = await new KeycloakJwtGuard(ISSUER, getKey).canActivate(contextFor(request));
  return { allowed, request };
}

describe('KeycloakJwtGuard', () => {
  test('public paths pass without a token and without touching the key set', async () => {
    const failingKeys: JWTVerifyGetKey = () => {
      throw new Error('key set must not be used');
    };
    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      expect((await authenticate(undefined, path, failingKeys)).allowed).toBe(true);
    }
  });

  test('a valid token sets principal.providerId from azp', async () => {
    const { allowed, request } = await authenticate(`Bearer ${await token()}`);
    expect(allowed).toBe(true);
    expect(request.principal).toEqual({ providerId: 'provider-a', subject: 'svc-1' });
  });

  test('the Bearer scheme is case-insensitive', async () => {
    expect((await authenticate(`bearer ${await token()}`)).allowed).toBe(true);
  });

  test.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['Bearer without a token', 'Bearer '],
  ])('%s → UnauthenticatedError', async (_label, header) => {
    await expect(authenticate(header)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test.each<[string, () => Promise<string>]>([
    ['a garbage token', async () => 'not-a-jwt'],
    ['a token signed by an unknown key', () => token({ key: untrusted })],
    ['another issuer', () => token({ issuer: 'http://evil.example/realms/wagering' })],
    ['another audience', () => token({ audience: 'account' })],
    ['no audience', () => token({ audience: null })],
    ['an expired token', () => token({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
    ['no azp claim', () => token({ claims: {} })],
    ['an empty azp claim', () => token({ claims: { azp: '' } })],
  ])('%s → UnauthenticatedError', async (_label, makeToken) => {
    const header = `Bearer ${await makeToken()}`;
    await expect(authenticate(header)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test('an unreachable key set is a transient failure (503), not the caller fault', async () => {
    const unreachable: JWTVerifyGetKey = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(authenticate(`Bearer ${await token()}`, '/wallets', unreachable)).rejects.toBeInstanceOf(TransientInfraError);
  });
});
