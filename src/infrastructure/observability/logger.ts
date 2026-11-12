import pino from 'pino';
import type { AppLogger } from '../../application/ports/logger';
import type { Env } from '../config/env';
import { requestContext } from './request-context';

/** Keys holding financial values; redacted at the top level and one level down (constitution #29). */
const FINANCIAL_KEYS = ['money', 'amount', 'balance', 'initialBalance', 'observedBalance', 'storedBalance', 'calculatedBalance', 'difference'];

export const REDACTED_PATHS = [
  ...FINANCIAL_KEYS,
  ...FINANCIAL_KEYS.map((k) => `*.${k}`),
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'body',
  'req.body',
];

/** JSON logger; each line carries the fields of the current request context. */
export function createLogger(env: Pick<Env, 'LOG_LEVEL'>, destination?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level: env.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS },
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
      // A copy: pino merges the line into the mixin object, which must not leak into the context.
      mixin: () => ({ ...requestContext.getStore() }),
    },
    destination,
  );
}

export function toAppLogger(logger: pino.Logger): AppLogger {
  return {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
}
