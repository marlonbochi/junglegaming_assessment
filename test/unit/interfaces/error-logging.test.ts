import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import type pino from 'pino';
import { PermanentInfraError, TransientInfraError } from '../../../src/application/errors';
import { describeError } from '../../../src/interfaces/describe-error';
import { ProblemDetailsFilter } from '../../../src/interfaces/http/problem-details.filter';

/** What a trigger or CHECK violation looks like once MikroORM wrapped it: the message embeds amounts. */
const triggerViolation = () =>
  Object.assign(new Error('balance 10.00 does not match ledger 25.00 for wallet w-1'), {
    name: 'DriverException',
    code: '23000',
    constraint: 'wallets_ledger_consistency',
  });

describe('describeError', () => {
  test('logs the cause by name, SQLSTATE and constraint, never by message', () => {
    const line = describeError(new PermanentInfraError('Unexpected error while processing wager transaction', { cause: triggerViolation() }));
    expect(line).toBe(
      'PermanentInfraError: Unexpected error while processing wager transaction (cause: DriverException code=23000 constraint=wallets_ledger_consistency)',
    );
    expect(line).not.toContain('10.00');
  });

  test('a cause without code is named only; no cause, no suffix; non-errors are stringified', () => {
    expect(describeError(new TransientInfraError('lock timeout', { cause: new Error('secret 99.00') }))).toBe(
      'TransientInfraError: lock timeout (cause: Error)',
    );
    expect(describeError(new Error('plain'))).toBe('Error: plain');
    expect(describeError('text')).toBe('text');
  });
});

describe('ProblemDetailsFilter logging', () => {
  function filterWithLog() {
    const lines: Array<[string, Record<string, unknown>, string]> = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => void lines.push(['warn', obj, msg]),
      error: (obj: Record<string, unknown>, msg: string) => void lines.push(['error', obj, msg]),
    } as unknown as pino.Logger;
    const res = { setHeader: () => res, status: () => res, end: () => res };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    return { filter: new ProblemDetailsFilter(logger), host, lines };
  }

  test('a permanent failure logs its cause by name, SQLSTATE and constraint, never by message', () => {
    const { filter, host, lines } = filterWithLog();
    filter.catch(new PermanentInfraError('Unexpected error while processing wager transaction', { cause: triggerViolation() }), host);

    expect(lines).toHaveLength(1);
    const [level, fields, msg] = lines[0]!;
    expect([level, msg]).toEqual(['error', 'permanent failure']);
    expect(fields.cause).toEqual({ type: 'DriverException', code: '23000', constraint: 'wallets_ledger_consistency' });
    expect(JSON.stringify(fields)).not.toContain('10.00');
  });
});
