import { describe, expect, test } from 'bun:test';
import { createLogger, toAppLogger } from '../../../src/infrastructure/observability/logger';
import { enrichRequestContext, requestContext } from '../../../src/infrastructure/observability/request-context';

function capture(level: 'info' | 'silent' = 'info') {
  const lines: Array<Record<string, any>> = [];
  const logger = createLogger({ LOG_LEVEL: level }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

const money = { amount: '25.00', currency: 'BRL' };

describe('createLogger', () => {
  test('redacts money, balances and authorization; keeps the correlationId from the request context', () => {
    const { logger, lines } = capture();
    requestContext.run({ correlationId: 'corr-1' }, () => {
      logger.info(
        {
          money,
          balance: money,
          amount: '25.00',
          initialBalance: money,
          result: { balance: money, money, storedBalance: money },
          req: { headers: { authorization: 'Bearer secret' }, body: { money } },
          walletId: 'w-1',
        },
        'something happened',
      );
    });

    const [line] = lines;
    expect(line).toMatchObject({
      level: 'info',
      msg: 'something happened',
      correlationId: 'corr-1',
      walletId: 'w-1',
      money: '[Redacted]',
      balance: '[Redacted]',
      amount: '[Redacted]',
      initialBalance: '[Redacted]',
      result: { balance: '[Redacted]', money: '[Redacted]', storedBalance: '[Redacted]' },
      req: { headers: { authorization: '[Redacted]' }, body: '[Redacted]' },
    });
    expect(JSON.stringify(lines)).not.toContain('25.00');
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  test('context fields added during the request show up in later lines, and the context itself is not mutated', () => {
    const { logger, lines } = capture();
    const store = { correlationId: 'corr-2' };
    requestContext.run(store, () => {
      enrichRequestContext({ walletId: 'w-2', providerId: 'provider-a' });
      logger.info({ status: 'PROCESSED' }, 'done');
    });
    expect(lines[0]).toMatchObject({ correlationId: 'corr-2', walletId: 'w-2', providerId: 'provider-a', status: 'PROCESSED' });
    expect(store).toEqual({ correlationId: 'corr-2', walletId: 'w-2', providerId: 'provider-a' } as typeof store);
  });

  test('outside a request no context fields are added', () => {
    const { logger, lines } = capture();
    logger.info({}, 'boot');
    expect(lines[0]).not.toHaveProperty('correlationId');
  });

  test('LOG_LEVEL silent writes nothing', () => {
    const { logger, lines } = capture('silent');
    logger.error({}, 'nope');
    expect(lines).toEqual([]);
  });

  test('toAppLogger forwards to pino with the same redaction', () => {
    const { logger, lines } = capture();
    toAppLogger(logger).error({ walletId: 'w-3', balance: money }, 'mismatch');
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'mismatch', walletId: 'w-3', balance: '[Redacted]' });
  });
});
