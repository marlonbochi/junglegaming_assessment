import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { loadEnv } from '../../src/infrastructure/config/env';
import { bootstrapApi, type ApiOverrides } from '../../src/main.api';

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
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
  api: TestApi,
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
