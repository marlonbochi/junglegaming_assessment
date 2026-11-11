import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { Mix, checkDecision, correctnessThresholds, countStatus, decided, errorThresholds, request, submit, trendStats } from './lib/payloads.js';
import { wallets } from './lib/seed.js';

/**
 * ~30% of requests are duplicates of a command already sent, over every seeded wallet:
 *  - 20% of iterations re-send, later, a command this VU already got an answer for (sequential replay);
 *  - 15% of iterations send a new command twice at the same time (`http.batch`: concurrent duplicate);
 *  - the rest are new commands (BET/WIN/LOSS mix).
 * Duplicates share request share = (0.20 + 0.15) / 1.15 ≈ 30%. Every duplicate must return the same
 * transactionId and status as the original, with `idempotentReplay: true` and no second effect
 * (checked by reconciliation and by `wagering_duplicates_total` vs `duplicates_sent` in run.ts).
 */
const RATE = Number(__ENV.RATE || 150);

export const options = {
  scenarios: {
    duplicates: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '120s',
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  summaryTrendStats: trendStats,
  thresholds: {
    ...correctnessThresholds,
    ...errorThresholds,
    ...Object.fromEntries(
      ['no', 'replay', 'pair'].flatMap((dup) => [
        [`http_req_duration{dup:${dup}}`, ['max>=0']],
        [`http_reqs{dup:${dup}}`, ['count>=0']],
        [`http_req_failed{dup:${dup}}`, ['rate>=0']],
      ]),
    ),
  },
};

const duplicatesSent = new Counter('duplicates_sent');
const mix = new Mix(() => wallets[Math.floor(Math.random() * wallets.length)]);
/** Commands this VU got a decided answer for: { cmd, status, transactionId }. */
const answered = [];

function remember(cmd, res, body) {
  if (!body?.transactionId) return;
  const entry = { cmd, status: res.status, transactionId: body.transactionId };
  if (answered.length < 200) answered.push(entry);
  else answered[Math.floor(Math.random() * answered.length)] = entry;
}

function fresh() {
  const cmd = mix.next();
  const res = submit(cmd, { dup: 'no' });
  const body = checkDecision(cmd, res, false);
  mix.record(cmd, res);
  remember(cmd, res, body);
}

function replay() {
  const original = answered[Math.floor(Math.random() * answered.length)];
  duplicatesSent.add(1);
  const res = submit(original.cmd, { dup: 'replay' });
  const body = checkDecision(original.cmd, res, true, { dup: 'replay' });
  if (!decided(res)) return;
  check(
    res,
    {
      'replay keeps the original status': (r) => r.status === original.status,
      'replay keeps the original transactionId': () => body?.transactionId === original.transactionId,
      'replay carries Idempotent-Replayed': (r) => r.headers['Idempotent-Replayed'] === 'true',
    },
    { type: 'correctness' },
  );
}

function concurrentPair() {
  const cmd = mix.next();
  duplicatesSent.add(1);
  const responses = http.batch([request(cmd, { dup: 'pair' }), request(cmd, { dup: 'pair' })]);
  responses.forEach(countStatus);
  const [a, b] = responses;
  const bodies = responses.map((r) => checkDecision(cmd, r, undefined, { dup: 'pair' }));
  if (!decided(a) || !decided(b)) return;
  const [ba, bb] = bodies;
  check(
    a,
    {
      'concurrent duplicates share status': () => a.status === b.status,
      'concurrent duplicates share transactionId': () => ba?.transactionId !== undefined && ba.transactionId === bb?.transactionId,
      'exactly one concurrent duplicate is the original': () => [ba, bb].filter((x) => x?.idempotentReplay === false).length === 1,
    },
    { type: 'correctness' },
  );
  mix.record(cmd, a);
  remember(cmd, a, ba);
}

export default function () {
  const r = Math.random();
  if (r < 0.2 && answered.length > 0) replay();
  else if (r < 0.35) concurrentPair();
  else fresh();
}

