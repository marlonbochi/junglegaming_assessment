import { Mix, checkDecision, correctnessThresholds, errorThresholds, submit, trendStats } from './lib/payloads.js';
import { wallets } from './lib/seed.js';

/**
 * Hot wallets: every request serialises on a handful of wallet row locks (`SELECT … FOR UPDATE`).
 * Phase `hot10` spreads RATE req/s over 10 wallets; phase `hot1` sends RATE req/s to a single wallet;
 * phase `hot1high` sends HIGH_RATE req/s (default 400, ~80% of the distributed capacity) to that same
 * wallet, to compare one serialised wallet with 1000 wallets at the same rate.
 * Wallets start with 1000.00, so the BET/WIN/LOSS mix drains them and INSUFFICIENT_FUNDS (422) is
 * exercised under contention too. run.ts seeds 11 wallets: [0..9] for hot10, [10] for hot1.
 */
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '90s';

const phase = (name, startTime, rate = RATE, duration = DURATION) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration,
  preAllocatedVUs: 50,
  maxVUs: 300,
  startTime,
  exec: name,
  tags: { phase: name },
});

export const options = {
  scenarios: {
    hot10: phase('hot10', '0s'),
    hot1: phase('hot1', __ENV.HOT1_START || '95s'),
    hot1high: phase('hot1high', __ENV.HOT1HIGH_START || '190s', Number(__ENV.HIGH_RATE || 400), __ENV.HIGH_DURATION || '60s'),
  },
  summaryTrendStats: trendStats,
  thresholds: {
    ...correctnessThresholds,
    ...errorThresholds,
    'http_req_duration{phase:hot10}': ['max>=0'],
    'http_req_duration{phase:hot1}': ['max>=0'],
    'http_reqs{phase:hot10}': ['count>=0'],
    'http_reqs{phase:hot1}': ['count>=0'],
    'http_req_failed{phase:hot10}': ['rate>=0'],
    'http_req_failed{phase:hot1}': ['rate>=0'],
    'http_req_duration{phase:hot1high}': ['max>=0'],
    'http_reqs{phase:hot1high}': ['count>=0'],
    'http_req_failed{phase:hot1high}': ['rate>=0'],
  },
};

const ten = new Mix(() => wallets[Math.floor(Math.random() * 10)]);
const one = new Mix(() => wallets[10]);

function run(mix) {
  const cmd = mix.next();
  const res = submit(cmd);
  checkDecision(cmd, res, false);
  mix.record(cmd, res);
}

export const hot10 = () => run(ten);
export const hot1 = () => run(one);
export const hot1high = () => run(one);
