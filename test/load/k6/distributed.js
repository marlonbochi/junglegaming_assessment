import exec from 'k6/execution';
import { Mix, checkDecision, correctnessThresholds, serverErrorThresholds, submit, trendStats } from './lib/payloads.js';
import { wallets } from './lib/seed.js';

/**
 * Distributed load over every seeded wallet (1000), BET/WIN/LOSS mix, as a staircase of
 * arrival rates: each LEVEL is reached in RAMP_S seconds and held for HOLD_S seconds. Requests are
 * tagged with the level being held (`stage:L0100`, or `ramp`), so the summary has latency, throughput
 * and error rate per level and run.ts can find the saturation point (achieved rate < target, p95 or
 * errors climbing). Going past saturation is the point, so the error-rate SLO is not a threshold here;
 * correctness is, and so is "no 5xx and no unexpected 4xx" (timeouts stay reportable).
 */
const LEVELS = (__ENV.LEVELS || '100,200,300,400,500,600,700').split(',').map(Number);
const RAMP_S = Number(__ENV.RAMP_S || 5);
const HOLD_S = Number(__ENV.HOLD_S || 30);

const stageName = (level) => `L${String(level).padStart(4, '0')}`;

const perStage = {};
for (const level of LEVELS) {
  const tag = `{stage:${stageName(level)}}`;
  perStage[`http_req_duration${tag}`] = ['max>=0'];
  perStage[`http_reqs${tag}`] = ['count>=0'];
  perStage[`http_req_failed${tag}`] = ['rate>=0'];
}

export const options = {
  scenarios: {
    staircase: {
      executor: 'ramping-arrival-rate',
      startRate: LEVELS[0],
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: Number(__ENV.MAX_VUS || 300),
      stages: LEVELS.flatMap((target) => [
        { target, duration: `${RAMP_S}s` },
        { target, duration: `${HOLD_S}s` },
      ]),
    },
  },
  summaryTrendStats: trendStats,
  thresholds: { ...correctnessThresholds, ...serverErrorThresholds, ...perStage },
};

function currentStage() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  const slot = RAMP_S + HOLD_S;
  const i = Math.floor(elapsed / slot);
  if (i >= LEVELS.length || elapsed - i * slot < RAMP_S) return 'ramp';
  return stageName(LEVELS[i]);
}

const mix = new Mix(() => wallets[Math.floor(Math.random() * wallets.length)]);

export default function () {
  const cmd = mix.next();
  const res = submit(cmd, { stage: currentStage() });
  checkDecision(cmd, res, false);
  mix.record(cmd, res);
}
