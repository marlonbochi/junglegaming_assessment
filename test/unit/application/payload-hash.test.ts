import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '../../../src/application/hashing/canonical-json';
import { payloadHash } from '../../../src/application/hashing/payload-hash';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction.types';
import type { WagerCommand } from '../../../src/application/commands/wager-command';

const cmd: WagerCommand = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'idem-1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Win,
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: 'ext-0',
};

const reorderKeys = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, v && typeof v === 'object' ? reorderKeys(v) : v])) as T;

const omit = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => {
  const { [k]: _, ...rest } = o;
  return rest;
};

describe('canonicalJson', () => {
  test('canonicalJson sorts keys recursively and drops undefined', () =>
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 'x' } })).toBe('{"a":{"c":"x"},"b":1}'));

  test('canonicalJson rejects floats', () => expect(() => canonicalJson({ a: 1.5 })).toThrow());

  test('canonicalJson rejects bigint and functions', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });

  test('canonicalJson handles arrays, null and integers', () =>
    expect(canonicalJson({ a: [2, { z: null, y: true }] })).toBe('{"a":[2,{"y":true,"z":null}]}'));
});

describe('payloadHash', () => {
  test('hash ignores key order and idempotencyKey', () =>
    expect(payloadHash({ ...cmd, idempotencyKey: 'other' })).toBe(payloadHash(reorderKeys(cmd))));

  test('hash changes when a business field changes', () =>
    expect(payloadHash({ ...cmd, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(payloadHash(cmd)));

  test('absent and undefined reference hash the same', () =>
    expect(payloadHash({ ...cmd, referenceExternalTransactionId: undefined })).toBe(
      payloadHash(omit(cmd, 'referenceExternalTransactionId')),
    ));

  test('hash is 64 hex chars and stable across runs', () => {
    expect(payloadHash(cmd)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash(cmd)).toBe('d417b3166c847ecc6cfe9f1259c9a22eaee1fa28f7d364dc24facd5037545fd3');
  });
});
