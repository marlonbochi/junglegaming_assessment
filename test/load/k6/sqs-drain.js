import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { AWSConfig, SQSClient } from 'https://jslib.k6.io/aws/0.14.0/sqs.js';
import { Mix } from './lib/payloads.js';
import { wallets } from './lib/seed.js';

/**
 * Enqueue phase of the drain scenario: MESSAGES wager commands sent to `wager-transactions.fifo` with
 * SendMessageBatch (10 per call), in the README §10 envelope, while no consumer runs. Each message
 * picks a random seeded wallet (group = walletId); WIN/LOSS reference a BET this VU enqueued before in
 * the same group, so FIFO order guarantees the reference is processed first. run.ts then starts N
 * consumers and measures the time until the queue is empty.
 */
const MESSAGES = Number(__ENV.MESSAGES || 50000);
const BATCH = 10;

export const options = {
  scenarios: {
    enqueue: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 20),
      iterations: Math.ceil(MESSAGES / BATCH),
      maxDuration: '10m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: { 'checks{type:enqueue}': ['rate==1'] },
};

const sqs = new SQSClient(
  new AWSConfig({
    region: __ENV.AWS_REGION,
    accessKeyId: __ENV.AWS_ACCESS_KEY_ID,
    secretAccessKey: __ENV.AWS_SECRET_ACCESS_KEY,
    endpoint: __ENV.SQS_ENDPOINT,
  }),
);
const queueUrl = __ENV.WAGER_QUEUE_URL;
const enqueued = new Counter('messages_enqueued');
const mix = new Mix(() => wallets[Math.floor(Math.random() * wallets.length)]);

function entry(cmd, n) {
  const messageId = crypto.randomUUID();
  const envelope = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...cmd.body, idempotencyKey: cmd.key },
  };
  return {
    messageId: String(n),
    messageBody: JSON.stringify(envelope),
    messageOptions: { messageGroupId: cmd.body.walletId, messageDeduplicationId: messageId },
  };
}

export default async function () {
  const entries = [];
  for (let n = 0; n < BATCH; n++) {
    const cmd = mix.next();
    mix.recordSent(cmd);
    entries.push(entry(cmd, n));
  }
  let failed = entries.length;
  try {
    failed = (await sqs.sendMessageBatch(queueUrl, entries)).failed.length;
  } catch (e) {
    console.error(`SendMessageBatch failed: ${e}`);
  }
  enqueued.add(entries.length - failed);
  check(failed, { 'batch fully accepted': (f) => f === 0 }, { type: 'enqueue' });
}
