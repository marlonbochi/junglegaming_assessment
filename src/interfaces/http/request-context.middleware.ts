import type pino from 'pino';
import { requestContext, type RequestContext } from '../../infrastructure/observability/request-context';
import type { HttpRequest, HttpResponse } from './http-types';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Caller-supplied ids are kept only when they are short and log-safe. */
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * First middleware: `x-request-id` (or a new UUID v7) becomes the correlationId of the request context
 * and is echoed back; one access log line per request, without bodies.
 */
export function requestContextMiddleware(logger: pino.Logger) {
  return (req: HttpRequest, res: HttpResponse, next: () => void): void => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const correlationId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    const context: RequestContext = { correlationId };
    const started = performance.now();
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    res.on('finish', () => {
      logger.info(
        {
          ...context,
          method: req.method,
          route: req.route?.path ?? req.originalUrl.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        },
        'request completed',
      );
    });
    requestContext.run(context, next);
  };
}

export function currentCorrelationId(): string {
  const store = requestContext.getStore();
  if (!store) throw new Error('No request context: requestContextMiddleware must run first');
  return store.correlationId;
}
