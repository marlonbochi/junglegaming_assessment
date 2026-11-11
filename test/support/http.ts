import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type { WagerCommand } from '../../src/application/commands/wager-command';
import { loadEnv } from '../../src/infrastructure/config/env';
import { bootstrapApi, type ApiOverrides } from '../../src/main.api';
import { newId } from './persistence';
import type { WalletRef } from './use-cases';

/** Anything serving the HTTP API: an in-process `TestApi` or a spawned `api` process. */
export interface HttpTarget {
  baseUrl: string;
}

export interface TestApi extends HttpTarget {
  app: INestApplication;
  close(): Promise<void>;
}

/** Boots the real API against `databaseUrl` (LocalStack defaults), listening on a random local port. */
export async function startTestApi(
  databaseUrl: string,
  opts: { env?: Record<string, string>; overrides?: ApiOverrides } = {},
): Promise<TestApi> {
  const env = loadEnv({ DATABASE_URL: databaseUrl, DB_POOL_MAX: '5', JITTER: 'off', LOG_LEVEL: 'silent', ...opts.env });
  const app = await bootstrapApi(env, opts.overrides);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface HttpResult {
  status: number;
  headers: Headers;
  /** Parsed JSON for JSON / problem+json responses, raw text otherwise. */
  body: any;
}

/** Sends `body` as JSON (a string is sent verbatim, for malformed payloads). */
export async function call(
  api: HttpTarget,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: hasBody ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const text = await res.text();
  const isJson = /json/.test(res.headers.get('content-type') ?? '');
  return { status: res.status, headers: res.headers, body: isJson && text ? JSON.parse(text) : text };
}

/** POST /wallets for a new player; returns the created wallet. */
export async function openWalletVia(target: HttpTarget, amount: string, currency = 'BRL'): Promise<WalletRef> {
  const res = await call(target, 'POST', '/wallets', { body: { playerId: newId(), initialBalance: { amount, currency } } });
  if (res.status !== 201) throw new Error(`POST /wallets → ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, playerId: res.body.playerId };
}

/** POST /wagering/transactions with the command's idempotency key in its header. */
export function submitWager(target: HttpTarget, cmd: WagerCommand): Promise<HttpResult> {
  const { idempotencyKey, ...body } = cmd;
  return call(target, 'POST', '/wagering/transactions', { body, headers: { 'idempotency-key': idempotencyKey } });
}
