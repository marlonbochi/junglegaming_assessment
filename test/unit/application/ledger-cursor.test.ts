import { describe, expect, test } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../../src/application/use-cases/list-ledger';

const b64url = (s: string) => Buffer.from(s).toString('base64url');

describe('ledger cursor', () => {
  test.each(['', '!!!', b64url('{"v":-1}'), b64url('{"v":"2"}'), b64url('{"v":1.5}'), b64url('not json'), b64url('null'), b64url('{}')])(
    'rejects cursor %p',
    (c) => expect(() => decodeLedgerCursor(c)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' })),
  );

  test('roundtrip', () => expect(decodeLedgerCursor(encodeLedgerCursor(42))).toBe(42));
  test('encodes base64url of {"v":n}', () => expect(encodeLedgerCursor(7)).toBe(b64url('{"v":7}')));
});
