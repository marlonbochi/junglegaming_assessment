import { describe, expect, test } from 'bun:test';
import { ApplicationError, PermanentInfraError, TransientInfraError, UniqueViolationError } from '../../../src/application/errors';
import { decide } from '../../../src/interfaces/sqs/consumer-decision';
import { parseWagerMessage } from '../../../src/interfaces/sqs/wager-message.schema';

const noJitter = () => 0;
const fail = (error: unknown) => ({ ok: false, error }) as const;

describe('decide', () => {
  test('business outcome → ack', () => {
    expect(decide({ ok: true }, 1, noJitter)).toEqual({ action: 'ack' });
    expect(decide({ ok: true }, 7, noJitter)).toEqual({ action: 'ack' });
  });

  test.each(['INVALID_PAYLOAD', 'WALLET_NOT_FOUND', 'IDEMPOTENCY_KEY_REUSED', 'EXTERNAL_ID_CONFLICT', 'INBOX_PAYLOAD_MISMATCH'] as const)(
    '%s → dlq with reason',
    (code) => {
      expect(decide(fail(new ApplicationError(code)), 1, noJitter)).toEqual({ action: 'dlq', reason: code });
    },
  );

  test('PermanentInfraError → dlq INTERNAL_PROCESSING_ERROR', () => {
    expect(decide(fail(new PermanentInfraError('bug')), 1, noJitter)).toEqual({ action: 'dlq', reason: 'INTERNAL_PROCESSING_ERROR' });
  });

  test('transient → retry with exponential delay by receiveCount (1,2,4,8…, cap 60)', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => decide(fail(new TransientInfraError('down')), n, noJitter));
    expect(delays.map((d) => (d.action === 'retry' ? d.delaySeconds : d.action))).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  test('jitter is added and rounded up to whole seconds', () => {
    expect(decide(fail(new TransientInfraError()), 1, () => 0.5)).toEqual({ action: 'retry', delaySeconds: 2 });
    expect(decide(fail(new TransientInfraError()), 7, () => 0.999)).toEqual({ action: 'retry', delaySeconds: 72 });
  });

  test('unknown errors (and unresolved unique violations) are retried', () => {
    expect(decide(fail(new Error('?')), 1, noJitter)).toEqual({ action: 'retry', delaySeconds: 1 });
    expect(decide(fail(new UniqueViolationError('x')), 2, noJitter)).toEqual({ action: 'retry', delaySeconds: 2 });
    expect(decide(fail('not even an error'), 3, noJitter)).toEqual({ action: 'retry', delaySeconds: 4 });
  });

  test('a missing or zero receive count is treated as the first delivery', () => {
    expect(decide(fail(new TransientInfraError()), 0, noJitter)).toEqual({ action: 'retry', delaySeconds: 1 });
  });
});

describe('parseWagerMessage', () => {
  const data = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '00000000-0000-7000-8000-000000000001',
    walletId: '00000000-0000-7000-8000-000000000002',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const envelope = { messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data };
  const body = (value: unknown) => JSON.stringify(value);

  test('README §10 message is accepted', () => {
    expect<unknown>(parseWagerMessage(body(envelope))).toEqual({ ok: true, message: envelope });
  });

  test('reference is optional in data', () => {
    const withRef = { ...envelope, data: { ...data, kind: 'ROLLBACK', referenceExternalTransactionId: 'transaction-1' } };
    expect(parseWagerMessage(body(withRef))).toMatchObject({ ok: true });
  });

  test.each<[string, string | undefined]>([
    ['missing body', undefined],
    ['malformed JSON', '{"messageId":'],
    ['array', body([envelope])],
    ['unknown messageId', body({ ...envelope, messageId: undefined })],
    ['empty messageId', body({ ...envelope, messageId: '' })],
    ['messageId longer than 255', body({ ...envelope, messageId: 'm'.repeat(256) })],
  ])('%s → invalid without a readable messageId', (_name, raw) => {
    const parsed = parseWagerMessage(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed).not.toHaveProperty('messageId');
  });

  test.each<[string, unknown]>([
    ['other type', { ...envelope, type: 'WalletOpened' }],
    ['bad occurredAt', { ...envelope, occurredAt: 'yesterday' }],
    ['extra envelope field', { ...envelope, extra: 1 }],
    ['extra data field', { ...envelope, data: { ...data, extra: 1 } }],
    ['missing idempotencyKey', { ...envelope, data: { ...data, idempotencyKey: undefined } }],
    ['non-uuid walletId', { ...envelope, data: { ...data, walletId: 'abc' } }],
    ['non-uuid playerId', { ...envelope, data: { ...data, playerId: 'abc' } }],
    ['OPENING kind', { ...envelope, data: { ...data, kind: 'OPENING' } }],
    ['numeric amount', { ...envelope, data: { ...data, money: { amount: 25, currency: 'BRL' } } }],
  ])('%s → invalid, keeping the readable messageId', (_name, value) => {
    expect(parseWagerMessage(body(value))).toMatchObject({ ok: false, messageId: 'msg-123' });
  });

  test('walletId is kept when readable, for the DLQ group', () => {
    expect(parseWagerMessage(body({ ...envelope, type: 'Other' }))).toEqual({ ok: false, messageId: 'msg-123', walletId: data.walletId });
    expect(parseWagerMessage(body({ ...envelope, data: { ...data, walletId: 42 } }))).toEqual({ ok: false, messageId: 'msg-123' });
  });
});
