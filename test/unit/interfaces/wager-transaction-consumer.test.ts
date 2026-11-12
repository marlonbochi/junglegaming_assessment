import { describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { noopLogger } from '../../../src/application/ports/logger';
import { noopMetrics } from '../../../src/application/ports/metrics';
import type { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
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
