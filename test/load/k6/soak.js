import exec from 'k6/execution';
import { Mix, checkDecision, correctnessThresholds, errorThresholds, submit, trendStats } from './lib/payloads.js';
import { wallets } from './lib/seed.js';

/**
 * Soak: a constant RATE (run.ts passes ~50% of the capacity measured by `distributed`) for MINUTES
 * minutes over every seeded wallet. Requests are tagged with their minute (`minute:m03`), so latency
 * drift over time is visible; run.ts samples container memory to spot leaks.
 */
const RATE = Number(__ENV.RATE || 100);
const MINUTES = Number(__ENV.MINUTES || 10);

const minuteTag = (m) => `m${String(m).padStart(2, '0')}`;
const perMinute = {};
for (let m = 0; m < MINUTES; m++) {
  perMinute[`http_req_duration{minute:${minuteTag(m)}}`] = ['max>=0'];
  perMinute[`http_reqs{minute:${minuteTag(m)}}`] = ['count>=0'];
}

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${MINUTES}m`,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  summaryTrendStats: trendStats,
  thresholds: { ...correctnessThresholds, ...errorThresholds, ...perMinute },
};

const mix = new Mix(() => wallets[Math.floor(Math.random() * wallets.length)]);

export default function () {
  const minute = Math.min(MINUTES - 1, Math.floor((Date.now() - exec.scenario.startTime) / 60000));
  const cmd = mix.next();
  const res = submit(cmd, { minute: minuteTag(minute) });
  checkDecision(cmd, res, false);
  mix.record(cmd, res);
}
