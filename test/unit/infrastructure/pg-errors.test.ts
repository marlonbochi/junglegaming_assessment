import { describe, expect, test } from 'bun:test';
import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { classifyPgError, uniqueConstraintName } from '../../../src/infrastructure/persistence/pg-errors';

const pgError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`pg error ${code}`), { code, ...extra });

describe('classifyPgError', () => {
  test('23505 is a unique violation, also when wrapped by MikroORM', () => {
    const raw = pgError('23505', { constraint: 'wallets_pkey' });
    expect(classifyPgError(raw)).toBe('unique_violation');
    expect(classifyPgError(new UniqueConstraintViolationException(raw))).toBe('unique_violation');
  });

  test('55P03 is a lock timeout', () => {
    expect(classifyPgError(pgError('55P03'))).toBe('lock_timeout');
  });

  test.each([
    '57014',
    '08000',
    '08006',
    '08P01',
    '53300',
    '57P01',
    '40P01',
    '40001',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])('%s is transient', (code) => {
    expect(classifyPgError(pgError(code))).toBe('transient');
  });

  test('a transient cause makes the error transient', () => {
    expect(classifyPgError(new Error('wrapped', { cause: pgError('ECONNREFUSED') }))).toBe('transient');
  });

  test('an unresolvable host is transient, also when wrapped by MikroORM', () => {
    const raw = pgError('ENOTFOUND', { message: 'getaddrinfo ENOTFOUND postgres' });
    expect(classifyPgError(new DriverException(raw))).toBe('transient');
    expect(classifyPgError(new Error('wrapped', { cause: new DriverException(raw) }))).toBe('transient');
  });

  test.each([
    'Connection terminated unexpectedly',
    'Connection terminated',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])('code-less pg error "%s" is transient, also as a cause', (message) => {
    expect(classifyPgError(new Error(message))).toBe('transient');
    expect(classifyPgError(new DriverException(new Error(message)))).toBe('transient');
    expect(classifyPgError(new Error('wrapped', { cause: new Error(message) }))).toBe('transient');
  });

  test('a connection-like message with an unrelated code stays as that code says', () => {
    expect(classifyPgError(pgError('23514', { message: 'Connection terminated' }))).toBe('other');
  });

  test.each(['23000', '23514', '23503', '42P01'])('%s is other', (code) => {
    expect(classifyPgError(pgError(code))).toBe('other');
  });

  test('non-database errors are other', () => {
    expect(classifyPgError(new Error('boom'))).toBe('other');
    expect(classifyPgError(Object.assign(new Error('app'), { code: 'WALLET_NOT_FOUND' }))).toBe('other');
    expect(classifyPgError('a string')).toBe('other');
    expect(classifyPgError(undefined)).toBe('other');
  });
});

describe('uniqueConstraintName', () => {
  test('uses the constraint field', () => {
    expect(uniqueConstraintName(pgError('23505', { constraint: 'inbox_messages_pkey' }))).toBe('inbox_messages_pkey');
  });

  test('falls back to the message, then to unknown', () => {
    const fromMessage = new Error('duplicate key value violates unique constraint "wallets_player_id_currency_key"');
    expect(uniqueConstraintName(fromMessage)).toBe('wallets_player_id_currency_key');
    expect(uniqueConstraintName(new Error('no name here'))).toBe('unknown');
  });
});
