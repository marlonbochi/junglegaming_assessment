import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ApplicationError, PermanentInfraError, TransientInfraError, type AppErrorCode } from '../../../src/application/errors';
import { FailedTransactionError, toProblem } from '../../../src/interfaces/http/problem-details';

const corr = 'corr-1';

describe('toProblem', () => {
  test.each<[AppErrorCode, number]>([
    ['INVALID_PAYLOAD', 400],
    ['MISSING_IDEMPOTENCY_KEY', 400],
    ['INVALID_CURSOR', 400],
    ['WALLET_NOT_FOUND', 422],
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['EXTERNAL_ID_CONFLICT', 409],
    ['WALLET_ALREADY_EXISTS', 409],
    ['INBOX_PAYLOAD_MISMATCH', 409],
    ['NOT_FOUND', 404],
  ])('ApplicationError %s → %d, not retryable', (code, status) => {
    const p = toProblem(new ApplicationError(code), corr);
    expect(p.status).toBe(status);
    expect(p.headers).toEqual({});
    expect(p.body).toEqual({
      type: `https://errors.wagering.local/${code.toLowerCase().replaceAll('_', '-')}`,
      title: expect.any(String),
      status,
      code,
      retryable: false,
      correlationId: corr,
    });
  });

  test('ApplicationError with a message exposes it as detail', () => {
    expect(toProblem(new ApplicationError('INVALID_PAYLOAD', 'walletId: Invalid UUID'), corr).body.detail).toBe(
      'walletId: Invalid UUID',
    );
  });

  test('TransientInfraError → 503 SERVICE_UNAVAILABLE retryable with Retry-After: 1, message hidden', () => {
    const p = toProblem(new TransientInfraError('connection refused to 10.0.0.1'), corr);
    expect(p).toMatchObject({ status: 503, headers: { 'Retry-After': '1' } });
    expect(p.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true, type: 'https://errors.wagering.local/service-unavailable' });
    expect(JSON.stringify(p.body)).not.toContain('10.0.0.1');
  });

  test('PermanentInfraError → 500 INTERNAL_ERROR retryable (nothing terminal recorded for the caller)', () => {
    const p = toProblem(new PermanentInfraError('boom'), corr);
    expect(p.status).toBe(500);
    expect(p.body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
  });

  test('FailedTransactionError → 500 INTERNAL_ERROR not retryable, with transactionId', () => {
    const p = toProblem(new FailedTransactionError('tx-1'), corr);
    expect(p.status).toBe(500);
    expect(p.body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false, transactionId: 'tx-1' });
  });

  test('unknown error → 500 INTERNAL_ERROR retryable, message hidden', () => {
    const p = toProblem(new Error('secret internals'), corr);
    expect(p.status).toBe(500);
    expect(p.body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    expect(JSON.stringify(p.body)).not.toContain('secret');
  });

  test('Nest exceptions: 404 → NOT_FOUND, client errors → INVALID_PAYLOAD with their status', () => {
    expect(toProblem(new NotFoundException('Cannot GET /x'), corr)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(toProblem(new BadRequestException('Unexpected end of JSON input'), corr)).toMatchObject({
      status: 400,
      body: { code: 'INVALID_PAYLOAD', retryable: false },
    });
    expect(toProblem(new PayloadTooLargeException(), corr)).toMatchObject({ status: 413, body: { code: 'INVALID_PAYLOAD' } });
  });
});
