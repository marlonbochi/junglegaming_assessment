import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { expect } from 'bun:test';
import type { WagerCommand } from '../../src/application/commands/wager-command';
import { eventually } from '../support/eventually';
import { call, openWalletVia, type HttpTarget } from '../support/http';
import { queueCounts, sendWagerMessage, type SendWagerOptions } from '../support/sqs';

/** E2E files only run against a live compose stack (`bun run test:e2e` sets this). */
export const e2eEnabled = process.env.E2E_COMPOSE === '1';

/** The compose stack as seen from the host: black box, only HTTP and SQS. */
export const api: HttpTarget = { baseUrl: 'http://localhost:3000' };

export const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4567',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const queueUrl = (name: string) => `http://localhost:4567/000000000000/${name}`;
export const wagerQueueUrl = queueUrl('wager-transactions.fifo');
export const dlqUrl = queueUrl('wager-transactions-dlq.fifo');
export const eventsUrl = queueUrl('wallet-events.fifo');

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export const openWallet = (amount = '100.00') => openWalletVia(api, amount);

export async function balanceOf(walletId: string): Promise<string> {
  const res = await call(api, 'GET', `/wallets/${walletId}`);
  expect(res.status).toBe(200);
  return res.body.balance.amount;
}

/** Every wallet's stored balance must equal the one rebuilt from its ledger. */
export async function reconcileAll(walletIds: string[]): Promise<void> {
  for (const id of walletIds) {
    const res = await call(api, 'POST', `/wallets/${id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ walletId: id, consistent: true, difference: brl('0.00') });
  }
}

/**
 * Reads a queue that several test files share by receiving AND deleting (an in-flight FIFO message
 * would block its group), keeping every body it ever saw. Because the cache lives in this module,
 * a message deleted while serving one file is still visible to the next one (bun runs all files
 * in one process); tests therefore match by their own ids with `where`, never by queue position.
 */
export class QueueTap {
  readonly messages: Message[] = [];
  constructor(private readonly url: string) {}

  private async pull(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      if (Messages.length === 0) return;
      this.messages.push(...Messages);
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: this.url,
          Entries: Messages.map((m, n) => ({ Id: String(n), ReceiptHandle: m.ReceiptHandle })),
        }),
      );
    }
  }

  /** Messages whose parsed-or-raw body satisfies `match` among everything this tap has read so far, now included. */
  async seen(match: (message: Message, body: any) => boolean): Promise<Message[]> {
    await this.pull();
    return this.messages.filter((m) => match(m, parse(m.Body)));
  }

  /** Messages whose parsed-or-raw body satisfies `match`, once at least `min` of them have shown up. */
  async where(match: (message: Message, body: any) => boolean, opts: { min?: number; timeoutMs?: number } = {}): Promise<Message[]> {
    const { min = 1, timeoutMs = 45_000 } = opts;
    return eventually(
      async () => {
        await this.pull();
        const hits = this.messages.filter((m) => match(m, parse(m.Body)));
        expect(hits.length).toBeGreaterThanOrEqual(min);
        return hits;
      },
      { timeoutMs, intervalMs: 200 },
    );
  }
}

function parse(body: string | undefined): any {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
}

export const eventsTap = new QueueTap(eventsUrl);
export const dlqTap = new QueueTap(dlqUrl);

/**
 * Asserts that none of `messageIds` was dead-lettered. The consumer sends to the DLQ before deleting
 * from the wager queue, so once that queue is drained a dead-lettered message is already in the DLQ.
 */
export async function expectNotDeadLettered(messageIds: string[]): Promise<void> {
  await eventually(async () => expect(await queueCounts(sqs, wagerQueueUrl)).toEqual({ visible: 0, inFlight: 0 }), {
    timeoutMs: 45_000,
  });
  expect(await dlqTap.seen((_m, b) => messageIds.includes(b?.messageId))).toEqual([]);
}

/** Asserts the README integration-event envelope (version 1) and returns it. */
export function expectEnvelope(event: any, eventType: string, aggregateId: string) {
  expect(event).toMatchObject({
    eventId: expect.any(String),
    eventType,
    aggregateId,
    correlationId: expect.any(String),
    occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    version: 1,
  });
  expect(typeof event.data).toBe('object');
}

/** Sends a wager command to the wager queue inside the README §10 envelope. */
export const sendWager = (cmd: WagerCommand, opts?: SendWagerOptions) => sendWagerMessage(sqs, wagerQueueUrl, { ...cmd }, opts);
