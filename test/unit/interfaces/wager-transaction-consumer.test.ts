import { describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { PermanentInfraError } from '../../../src/application/errors';
import { noopLogger } from '../../../src/application/ports/logger';
import { noopMetrics } from '../../../src/application/ports/metrics';
import type { SubmitResult, SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction.types';
import { SQS_REQUEST_HANDLER } from '../../../src/infrastructure/sqs/sqs-client';
import { WagerTransactionConsumer } from '../../../src/interfaces/sqs/wager-transaction.consumer';
import { eventually } from '../../support/eventually';

describe('WagerTransactionConsumer receive', () => {
  test('the 20s long poll gets a per-call request timeout above the wait, so the 5s client default does not cut it', async () => {
    const calls: Array<{ command: unknown; options: { requestTimeout?: number; abortSignal?: unknown } | undefined }> = [];
    // Records the call, then waits like an empty long poll until the consumer aborts it.
    const sqs = {
      send: (command: unknown, options?: { requestTimeout?: number; abortSignal?: AbortSignal }) => {
        calls.push({ command, options });
        return new Promise((_resolve, reject) => options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    } as unknown as SQSClient;
    const consumer = new WagerTransactionConsumer(sqs, {} as SubmitWagerTransaction, { hit: () => {} }, noopMetrics, noopLogger, () => 0, {
      queueUrl: 'q',
      dlqUrl: 'dlq',
      consumerName: 'c',
      visibilityTimeoutS: 30,
      shutdownGraceMs: 1000,
    });

    consumer.start();
    await eventually(async () => expect(calls).toHaveLength(1));
    await consumer.stop();

    const [{ command, options }] = calls as [(typeof calls)[number]];
    expect(command).toBeInstanceOf(ReceiveMessageCommand);
    expect((command as ReceiveMessageCommand).input.WaitTimeSeconds).toBe(20);
    expect(options?.requestTimeout).toBe(20_000 + SQS_REQUEST_HANDLER.requestTimeout);
    expect(options?.abortSignal).toBeDefined();
  });
});

describe('WagerTransactionConsumer FAILED replay', () => {
  const envelope = {
    messageId: 'msg-failed-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '00000000-0000-7000-8000-000000000001',
      walletId: '00000000-0000-7000-8000-000000000002',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  };
  const delivery = (receiveCount: number): Message => ({
    MessageId: 'sqs-message-1',
    ReceiptHandle: `receipt-${receiveCount}`,
    Body: JSON.stringify(envelope),
    Attributes: { ApproximateReceiveCount: String(receiveCount), MessageGroupId: envelope.data.walletId },
  });

  test('a redelivery that replays the FAILED row still dead-letters it when the first DLQ send failed', async () => {
    const sent: unknown[] = [];
    let dlqAvailable = false;
    const sqs = {
      send: async (command: unknown) => {
        if (command instanceof SendMessageCommand && !dlqAvailable) throw new Error('DLQ unavailable');
        sent.push(command);
        return {};
      },
    } as unknown as SQSClient;
    const failedReplay: SubmitResult = {
      transactionId: '00000000-0000-7000-8000-0000000000aa',
      status: WagerTransactionStatus.Failed,
      balance: { amount: '100.00', currency: 'BRL' },
      failureCode: FailureCode.InternalProcessingError,
      idempotentReplay: true,
    };
    let calls = 0;
    const submit = {
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new PermanentInfraError('bug');
        return failedReplay;
      },
    } as unknown as SubmitWagerTransaction;
    const consumer = new WagerTransactionConsumer(sqs, submit, { hit: () => {} }, noopMetrics, noopLogger, () => 0, {
      queueUrl: 'q',
      dlqUrl: 'dlq',
      consumerName: 'c',
      visibilityTimeoutS: 30,
      shutdownGraceMs: 1000,
    });

    // First delivery: FAILED is recorded, the DLQ send fails, so the message must not be deleted.
    await expect(consumer.handle(delivery(1))).rejects.toThrow('DLQ unavailable');
    expect(sent).toHaveLength(0);

    // Redelivery: the use case replays FAILED; the consumer must dead-letter it, not ack it.
    dlqAvailable = true;
    expect(await consumer.handle(delivery(2))).toEqual({ action: 'dlq', reason: 'INTERNAL_PROCESSING_ERROR' });
    expect(sent.map((c) => c?.constructor)).toEqual([SendMessageCommand, DeleteMessageCommand]);
    const dlqSend = sent[0] as SendMessageCommand;
    expect(dlqSend.input.QueueUrl).toBe('dlq');
    expect(dlqSend.input.MessageAttributes?.reason?.StringValue).toBe('INTERNAL_PROCESSING_ERROR');
  });
});
