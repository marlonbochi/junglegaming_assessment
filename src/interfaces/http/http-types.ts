import type { IncomingMessage, ServerResponse } from 'node:http';

/** The slice of Express' request/response this layer uses (no @types/express in the project). */
export interface HttpRequest extends IncomingMessage {
  path: string;
  originalUrl: string;
  route?: { path: string };
  principal?: unknown;
}

export interface HttpResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
}
