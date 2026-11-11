import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

export const API = __ENV.API_URL || 'http://api:3000';

const AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const STATUS_OF = { 200: 'PROCESSED', 202: 'PENDING_REFERENCE', 422: 'REJECTED' };

// A 422 INSUFFICIENT_FUNDS is a business answer, not a failure: only 5xx, timeouts and
// unexpected 4xx count in http_req_failed.
http.setResponseCallback(http.expectedStatuses(200, 202, 422));

/** Every response by status family; `responses_unexpected_4xx` and `responses_5xx` are errors. */
const responses = {
  ok: new Counter('responses_2xx'),
  rejected: new Counter('responses_422'),
  unexpected4xx: new Counter('responses_unexpected_4xx'),
  server: new Counter('responses_5xx'),
  none: new Counter('responses_no_status'),
};

let reported = 0;

export function countStatus(res) {
  if (res.status >= 200 && res.status < 300) responses.ok.add(1);
  else if (res.status === 422) responses.rejected.add(1);
  else if (res.status >= 400 && res.status < 500) responses.unexpected4xx.add(1);
  else if (res.status >= 500) responses.server.add(1);
  else responses.none.add(1);
  if (!(res.status in STATUS_OF) && reported++ < 5) {
    console.warn(`unexpected response ${res.status} ${res.error || ''} ${String(res.body).slice(0, 300)}`);
  }
}

/** The thresholds every scenario shares. Correctness is absolute; the error rate is an SLO. */
export const correctnessThresholds = { 'checks{type:correctness}': ['rate==1'] };
export const errorThresholds = { http_req_failed: ['rate<0.01'] };
/** Past saturation timeouts are expected, but a 5xx or an unexpected 4xx never is. */
export const serverErrorThresholds = { responses_5xx: ['count==0'], responses_unexpected_4xx: ['count==0'] };
export const trendStats = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const amount = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function command(wallet, kind, money, roundId, reference) {
  const id = crypto.randomUUID();
  const body = {
    providerId: 'provider-load',
    externalTransactionId: `${kind.toLowerCase()}-${id}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'game-load',
    kind,
    money: { amount: money, currency: 'BRL' },
  };
  if (reference !== undefined) body.referenceExternalTransactionId = reference;
  return { key: `key-${id}`, wallet, body };
}

/** A BET of 1.00–20.00 opening a new round. */
export function bet(wallet) {
  return command(wallet, 'BET', amount(randInt(100, 2000)), `round-${crypto.randomUUID()}`);
}

/** A WIN (0.50–40.00) or a LOSS settling `openBet`, in its round. */
export function settle(openBet, kind) {
  const money = kind === 'WIN' ? amount(randInt(50, 4000)) : openBet.body.money.amount;
  return command(openBet.wallet, kind, money, openBet.body.roundId, openBet.body.externalTransactionId);
}

/**
 * Per-VU traffic generator: ~60% BET, ~20% WIN, ~20% LOSS. WIN/LOSS always reference a BET that this
 * VU already saw PROCESSED, so they are decided immediately (no PENDING_REFERENCE by construction).
 */
export class Mix {
  constructor(pickWallet) {
    this.pickWallet = pickWallet;
    this.openBets = [];
  }

  next() {
    if (this.openBets.length > 0 && Math.random() < 0.4) {
      const i = Math.floor(Math.random() * this.openBets.length);
      const openBet = this.openBets[i];
      this.openBets[i] = this.openBets[this.openBets.length - 1];
      this.openBets.pop();
      return settle(openBet, Math.random() < 0.5 ? 'WIN' : 'LOSS');
    }
    return bet(this.pickWallet());
  }

  /** Remembers a BET once PROCESSED, so a later WIN/LOSS can settle it. */
  record(cmd, res) {
    if (res.status === 200) this.recordSent(cmd);
  }

  /** For SQS: the BET is settled later in the same FIFO group, so it is known to come first. */
  recordSent(cmd) {
    if (cmd.body.kind === 'BET' && this.openBets.length < 100) this.openBets.push(cmd);
  }
}

/** `http.batch`/`http.post` request for `cmd`. */
export function request(cmd, tags = {}) {
  return {
    method: 'POST',
    url: `${API}/wagering/transactions`,
    body: JSON.stringify(cmd.body),
    params: {
      headers: { 'content-type': 'application/json', 'idempotency-key': cmd.key },
      tags: { kind: cmd.body.kind, ...tags },
      timeout: '30s',
    },
  };
}

export function submit(cmd, tags = {}) {
  const r = request(cmd, tags);
  const res = http.post(r.url, r.body, r.params);
  countStatus(res);
  return res;
}

/** A response the service actually decided (not a 5xx or a timeout, which are errors, not answers). */
export const decided = (res) => res.status > 0 && res.status < 500;

export function json(res) {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}

/**
 * Correctness of a decided answer: the status the kind allows (BET may be refused only for
 * INSUFFICIENT_FUNDS), body status matching the HTTP status, a well-formed balance and the
 * expected `idempotentReplay` flag (`replay` undefined: not checked).
 */
export function checkDecision(cmd, res, replay, tags = {}) {
  if (!decided(res)) return undefined;
  const body = json(res);
  check(
    res,
    {
      'status allowed for the kind': (r) =>
        r.status === 200 || (cmd.body.kind === 'BET' && r.status === 422 && body?.failureCode === 'INSUFFICIENT_FUNDS'),
      'body status matches HTTP status': (r) => body?.status === STATUS_OF[r.status],
      'balance is a 2-decimal BRL amount': () => AMOUNT.test(body?.balance?.amount ?? '') && body.balance.currency === 'BRL',
      'idempotentReplay flag': () => replay === undefined || body?.idempotentReplay === replay,
    },
    { type: 'correctness', ...tags },
  );
  return body;
}
