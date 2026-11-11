import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { newId } from './persistence';

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  destroy(): Promise<void>;
}

export interface TestQueueOptions {
  /** Redrive to the DLQ after this many receives (production: 5). */
  maxReceiveCount?: number;
  /** Default visibility timeout of the wager queue, in seconds. */
  visibilityTimeout?: number;
}

/** FIFO queues of their own, wired like infra/localstack/init (wager queue redrives to its DLQ). */
export async function createTestQueues(sqs: SQSClient, prefix: string, opts: TestQueueOptions = {}): Promise<TestQueues> {
  const base = `${prefix}-${newId().slice(-12)}`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const create = async (name: string, attributes: Record<string, string>) => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `${base}-${name}.fifo`, Attributes: attributes }));
    if (!QueueUrl) throw new Error(`queue ${name} was not created`);
    return QueueUrl;
  };
  const dlqUrl = await create('dlq', fifo);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const queueUrl = await create('wager', {
    ...fifo,
    VisibilityTimeout: String(opts.visibilityTimeout ?? 30),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(opts.maxReceiveCount ?? 5) }),
  });
  const eventsUrl = await create('events', fifo);
  return {
    queueUrl,
    dlqUrl,
    eventsUrl,
    async destroy() {
      await Promise.all([queueUrl, dlqUrl, eventsUrl].map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
    },
  };
}

export interface SendWagerOptions {
  /** Envelope `messageId` (default: a new uuid). */
  messageId?: string;
  /** SQS deduplication id (default: the envelope `messageId`, like producers do). */
  deduplicationId?: string;
  /** Default: `data.walletId`. */
  groupId?: string;
  /** Sent verbatim instead of the envelope, for malformed messages. */
  rawBody?: string;
}

/** Wraps `data` in the README §10 envelope and sends it. */
export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  data: Record<string, unknown>,
  opts: SendWagerOptions = {},
): Promise<{ messageId: string; sqsMessageId: string; body: string }> {
  const messageId = opts.messageId ?? newId();
  const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
  const body = opts.rawBody ?? JSON.stringify(envelope);
  const { MessageId } = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: opts.groupId ?? String(data.walletId ?? 'unknown'),
      MessageDeduplicationId: opts.deduplicationId ?? messageId,
    }),
  );
  if (!MessageId) throw new Error('message was not sent');
  return { messageId, sqsMessageId: MessageId, body };
}

/** Every message that becomes receivable within `waitMs` (left on the queue, invisible for 30s). */
export async function receiveAll(sqs: SQSClient, queueUrl: string, opts: { waitMs: number }): Promise<Message[]> {
  const deadline = Date.now() + opts.waitMs;
  const received: Message[] = [];
  for (let remaining = opts.waitMs; remaining > 0; remaining = deadline - Date.now()) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: Math.min(Math.floor(remaining / 1000), 20),
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    received.push(...Messages);
  }
  return received;
}

/** Approximate counts; LocalStack reports them exactly. */
export async function queueCounts(sqs: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible),
  };
}

/**
 * Receives and deletes (so FIFO groups keep flowing) until `done(received)` holds; throws on timeout.
 * Every receipt is returned, duplicates included.
 */
export async function drainUntil(
  sqs: SQSClient,
  queueUrl: string,
  done: (received: Message[]) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<Message[]> {
  const received: Message[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (!done(received)) {
    if (Date.now() > deadline) throw new Error(`drained ${received.length} messages without reaching the expected state`);
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['All'] }),
    );
    if (Messages.length === 0) continue;
    received.push(...Messages);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return received;
}

/** Distinct `eventId`s of integration events received from `wallet-events.fifo`. */
export function eventIdsOf(messages: Message[]): Set<string> {
  return new Set(messages.map((m) => JSON.parse(m.Body ?? '{}').eventId as string));
}
