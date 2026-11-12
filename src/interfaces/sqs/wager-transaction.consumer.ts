import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import type { FaultInjector } from '../../application/ports/fault-injector';
import type { AppLogger } from '../../application/ports/logger';
import type { Metrics } from '../../application/ports/metrics';
import type { SubmitResult, SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import { backoffDelayMs, type BackoffConfig } from '../../domain/messaging/backoff';
import { enrichRequestContext, requestContext } from '../../infrastructure/observability/request-context';
import { longPollRequestTimeoutMs } from '../../infrastructure/sqs/sqs-client';
import { describeError } from '../describe-error';
import { decide, type ConsumerDecision, type ProcessingOutcome } from './consumer-decision';
import { parseWagerMessage, type WagerMessage } from './wager-message.schema';

export interface ConsumerConfig {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  visibilityTimeoutS: number;
  shutdownGraceMs: number;
}

const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 10;
/** Backoff of the poll loop itself while SQS is unreachable. */
const RECEIVE_BACKOFF: BackoffConfig = { baseMs: 1000, capMs: 30_000 };
const MAX_DEDUPLICATION_ID_LENGTH = 128;
const INVALID_PAYLOAD: ConsumerDecision = { action: 'dlq', reason: 'INVALID_PAYLOAD' };

interface Processed {
  decision: ConsumerDecision;
  result?: SubmitResult;
  error?: unknown;
}

/**
 * Spec §6.3: long-polls `wager-transactions.fifo` and runs each message through the same
 * SubmitWagerTransaction as HTTP. A message is deleted only after its transaction committed (or it was
 * dead-lettered); transient failures stay on the queue with a backoff visibility until the redrive policy.
 */
export class WagerTransactionConsumer {
  private readonly abort = new AbortController();
  private stopping = false;
  private loop?: Promise<void>;
  private stopped?: Promise<void>;
  /** Received and not yet acked, dead-lettered or scheduled for retry. */
  private readonly unfinished = new Set<Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly jitter: () => number,
    private readonly config: ConsumerConfig,
  ) {}

  start(): void {
    if (this.loop || this.stopping) return;
    this.logger.info({ queueUrl: this.config.queueUrl }, 'consumer started');
    this.loop = this.poll();
  }

  /** Stops polling, waits for in-flight messages up to the grace period and releases the rest. Idempotent. */
  stop(): Promise<void> {
    this.stopped ??= this.shutdown();
    return this.stopped;
  }

  /** Processes one message and applies the decision to the queue. */
  async handle(m: Message): Promise<ConsumerDecision> {
    const started = performance.now();
    const parsed = parseWagerMessage(m.Body);
    const messageId = (parsed.ok ? parsed.message.messageId : parsed.messageId) ?? m.MessageId ?? 'unknown';
    const walletId = parsed.ok ? parsed.message.data.walletId : parsed.walletId;
    const context = {
      correlationId: messageId,
      messageId,
      ...(walletId !== undefined ? { walletId } : {}),
      ...(parsed.ok ? { providerId: parsed.message.data.providerId } : {}),
    };
    return requestContext.run(context, async () => {
      const processed: Processed = parsed.ok
        ? await this.process(parsed.message, receiveCountOf(m))
        : { decision: INVALID_PAYLOAD };
      await this.apply(m, processed.decision, messageId, walletId);
      this.log(processed, parsed.ok ? parsed.message.data.kind : undefined, receiveCountOf(m), started);
      return processed.decision;
    });
  }

  private async process(message: WagerMessage, receiveCount: number): Promise<Processed> {
    const source = { type: 'sqs', consumerName: this.config.consumerName, messageId: message.messageId } as const;
    let result: SubmitResult | undefined;
    let outcome: ProcessingOutcome;
    try {
      result = await this.submit.execute(message.data, source, message.messageId);
      enrichRequestContext({ transactionId: result.transactionId });
      this.faults.hit('after_commit_before_ack');
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    }
    return { decision: decide(outcome, receiveCount, this.jitter), result, ...(outcome.ok ? {} : { error: outcome.error }) };
  }

  private async apply(m: Message, decision: ConsumerDecision, messageId: string, walletId: string | undefined): Promise<void> {
    switch (decision.action) {
      case 'ack':
        await this.delete(m);
        return;
      case 'dlq':
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.config.dlqUrl,
            MessageBody: m.Body ?? '',
            MessageAttributes: { reason: { DataType: 'String', StringValue: decision.reason } },
            MessageGroupId: m.Attributes?.MessageGroupId ?? walletId ?? 'unknown',
            MessageDeduplicationId: dlqDeduplicationId(m.MessageId ?? messageId, decision.reason),
          }),
        );
        this.metrics.dlq(decision.reason);
        await this.delete(m);
        return;
      case 'retry':
        await this.changeVisibility(m, decision.delaySeconds);
        this.metrics.retry('consumer');
        return;
    }
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let messages: Message[];
      try {
        messages = await this.receive();
        failures = 0;
      } catch (e) {
        if (this.stopping) return;
        this.metrics.retry('consumer-receive');
        this.logger.error({ error: describeError(e) }, 'receive failed');
        await this.pause(backoffDelayMs(failures++, { ...RECEIVE_BACKOFF, jitter: this.jitter }));
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        MaxNumberOfMessages: MAX_MESSAGES,
        VisibilityTimeout: this.config.visibilityTimeoutS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal, requestTimeout: longPollRequestTimeoutMs(WAIT_TIME_SECONDS) },
    );
    return Messages;
  }

  /**
   * Groups run concurrently; within a group (one wallet) messages keep their FIFO order. Once stopping,
   * messages not yet started stay unfinished and are released by `shutdown`.
   */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      this.unfinished.add(m);
      const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      const group = groups.get(key) ?? [];
      group.push(m);
      groups.set(key, group);
    }
    await Promise.allSettled(
      [...groups.values()].map(async (group) => {
        for (const m of group) {
          if (this.stopping) return;
          await this.handleSafely(m);
        }
      }),
    );
  }

  /** A failure applying the decision leaves the message invisible until its timeout: SQS redelivers it. */
  private async handleSafely(m: Message): Promise<void> {
    try {
      await this.handle(m);
    } catch (e) {
      this.logger.error({ messageId: m.MessageId, error: describeError(e) }, 'message handling failed');
    } finally {
      this.unfinished.delete(m);
    }
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.loop) {
      let timer: Timer | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.config.shutdownGraceMs);
      });
      await Promise.race([this.loop, grace]);
      clearTimeout(timer);
    }
    const released = [...this.unfinished];
    await Promise.allSettled(released.map((m) => this.changeVisibility(m, 0)));
    this.logger.info({ released: released.length }, 'consumer stopped');
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: Timer | undefined;
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        resolve();
      };
      this.abort.signal.addEventListener('abort', done, { once: true });
      timer = setTimeout(done, ms);
    });
  }

  private async delete(m: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: m.ReceiptHandle }));
  }

  private async changeVisibility(m: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: seconds }),
    );
  }

  /** One line per message (spec §8 fields); never the payload or amounts. */
  private log({ decision, result, error }: Processed, kind: string | undefined, receiveCount: number, started: number): void {
    const fields = {
      action: decision.action,
      ...(kind !== undefined ? { kind } : {}),
      ...(result ? { status: result.status, idempotentReplay: result.idempotentReplay } : {}),
      ...(result?.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
      ...(error !== undefined && !(error instanceof ApplicationError) ? { error: describeError(error) } : {}),
      receiveCount,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
    switch (decision.action) {
      case 'ack':
        this.logger.info(fields, 'message processed');
        return;
      case 'dlq':
        this.logger.warn({ ...fields, reason: decision.reason }, 'message dead-lettered');
        return;
      case 'retry':
        this.logger.warn({ ...fields, delaySeconds: decision.delaySeconds }, 'message retry scheduled');
        return;
    }
  }
}

/**
 * The SQS MessageId is unique per send and stable across redeliveries of that send, so two distinct
 * poison messages never collapse (the envelope messageId can repeat). SQS allows only printable ASCII.
 */
function dlqDeduplicationId(sqsMessageId: string, reason: string): string {
  return `${sqsMessageId}:${reason}`.replace(/[^\x21-\x7e]/g, '_').slice(0, MAX_DEDUPLICATION_ID_LENGTH);
}

function receiveCountOf(m: Message): number {
  return Number(m.Attributes?.ApproximateReceiveCount ?? 1);
}
