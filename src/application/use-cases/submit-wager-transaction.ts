import { computeNextAttemptAt, PENDING_REFERENCE_BACKOFF } from '../../domain/messaging/backoff';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/shared/failure-code';
import { settle } from '../../domain/wagering/wager-settlement';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { SubmissionSource, WagerCommand } from '../commands/wager-command';
import { ApplicationError, PermanentInfraError, TransientInfraError, UniqueViolationError } from '../errors';
import { payloadHash } from '../hashing/payload-hash';
import { lookupReference, persistSettlement } from '../persist-settlement';
import type { Clock, IdGenerator } from '../ports/clock';
import type { FaultInjector } from '../ports/fault-injector';
import type { Metrics } from '../ports/metrics';
import type { TxRepositories, UnitOfWork } from '../ports/unit-of-work';

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** Everything one submission needs, fixed before the first SQL transaction so a re-run is identical. */
interface Submission {
  cmd: WagerCommand;
  source: SubmissionSource;
  correlationId: string;
  hash: string;
  now: Date;
  /** Builds the PENDING transaction; cannot throw once `prepare` returned. */
  newTransaction: () => WagerTransaction;
}

interface Outcome {
  result: SubmitResult;
  kind: string;
  inboxDuplicate: boolean;
}

/**
 * Spec §6.1, shared by HTTP and SQS: idempotency, reference resolution, settlement, ledger, outbox and
 * inbox in one SQL transaction that locks the wallet first.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics,
    private readonly jitter: () => number,
  ) {}

  async execute(cmd: WagerCommand, source: SubmissionSource, correlationId: string): Promise<SubmitResult> {
    const started = performance.now();
    try {
      const submission = this.prepare(cmd, source, correlationId);
      let outcome: Outcome;
      try {
        outcome = await this.runOnceMore(submission);
      } catch (e) {
        if (isClassified(e)) throw e;
        throw await this.recordFailure(submission, e);
      }
      this.count(outcome, source);
      return outcome.result;
    } finally {
      this.metrics.processingDuration(source.type, (performance.now() - started) / 1000);
    }
  }

  /** Validation outside the transaction: any DomainError building the inputs is a bad payload. */
  private prepare(cmd: WagerCommand, source: SubmissionSource, correlationId: string): Submission {
    const hash = payloadHash(cmd);
    const now = this.clock.now();
    const id = this.ids.next();
    const newTransaction = () =>
      WagerTransaction.create({
        id,
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash: hash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money: Money.from(cmd.money),
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        now,
      });
    try {
      newTransaction();
    } catch (e) {
      if (e instanceof DomainError) throw new ApplicationError('INVALID_PAYLOAD', e.message);
      throw e;
    }
    return { cmd, source, correlationId, hash, now, newTransaction };
  }

  /**
   * An unexpected unique violation (e.g. same key on another wallet, so the two runs locked different
   * wallets) rolls back; one complete re-run then resolves it as replay or conflict in step 3.
   */
  private async runOnceMore(s: Submission): Promise<Outcome> {
    try {
      return await this.uow.run((r) => this.process(r, s));
    } catch (e) {
      if (!(e instanceof UniqueViolationError)) throw e;
      this.metrics.lockConflict();
      return this.uow.run((r) => this.process(r, s));
    }
  }

  private async process(r: TxRepositories, s: Submission): Promise<Outcome> {
    const { cmd, source, hash, now } = s;

    // 1. Wallet first (constitution #10).
    const wallet = await r.wallets.lockById(cmd.walletId);
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND');

    // 2. Inbox.
    let inboxDuplicate = false;
    if (source.type === 'sqs') {
      const received = await r.inbox.find(source.consumerName, source.messageId);
      if (received && received.payloadHash !== hash) throw new ApplicationError('INBOX_PAYLOAD_MISMATCH');
      inboxDuplicate = received !== undefined;
    }
    const recordInbox = async () => {
      if (source.type !== 'sqs' || inboxDuplicate) return;
      await r.inbox.insert(
        InboxMessage.receive({ messageId: source.messageId, consumerName: source.consumerName, payloadHash: hash, now }),
      );
    };

    // 3. Idempotency.
    const existing = await r.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(hash)) throw new ApplicationError('IDEMPOTENCY_KEY_REUSED');
      await recordInbox();
      return { result: resultOf(existing, wallet, true), kind: existing.kind, inboxDuplicate };
    }
    if (await r.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId)) {
      throw new ApplicationError('EXTERNAL_ID_CONFLICT');
    }

    // 4. Settlement.
    const tx = s.newTransaction();
    const settlement = settle({
      tx,
      wallet,
      reference: await lookupReference(r, cmd.providerId, cmd.referenceExternalTransactionId),
      ledgerEntryId: this.ids.next(),
      now,
      pendingRetryAt: computeNextAttemptAt(now, tx.attempts, { ...PENDING_REFERENCE_BACKOFF, jitter: this.jitter }),
    });

    // 5–6. Transaction, ledger + wallet, events, dependents nudged; then the inbox.
    await persistSettlement(
      r,
      { tx, wallet, settlement, write: 'insert', correlationId: s.correlationId, now },
      { ids: this.ids, faults: this.faults },
    );
    await recordInbox();

    this.faults.hit('before_commit');
    return { result: resultOf(tx, wallet, false), kind: tx.kind, inboxDuplicate };
  }

  /**
   * An unclassified error after validation is a bug: record the transaction as FAILED in its own SQL
   * transaction (wallet locked first) so replays stop retrying it, then surface it as permanent.
   */
  private async recordFailure(s: Submission, cause: unknown): Promise<PermanentInfraError> {
    try {
      const recorded = await this.uow.run(async (r) => {
        if (!(await r.wallets.lockById(s.cmd.walletId))) return false;
        if (await r.transactions.findByIdempotencyKey(s.cmd.idempotencyKey)) return false;
        const tx = s.newTransaction();
        tx.fail(FailureCode.InternalProcessingError, s.now);
        await r.transactions.insert(tx);
        return true;
      });
      if (recorded) this.metrics.transaction(WagerTransactionStatus.Failed, s.cmd.kind, s.source.type);
    } catch {
      // The original error is what matters; the message is retried or dead-lettered either way.
    }
    return new PermanentInfraError('Unexpected error while processing wager transaction', { cause });
  }

  private count(outcome: Outcome, source: SubmissionSource): void {
    if (outcome.inboxDuplicate) this.metrics.duplicate(source.type, 'inbox');
    if (outcome.result.idempotentReplay) this.metrics.duplicate(source.type, 'replay');
    else this.metrics.transaction(outcome.result.status, outcome.kind, source.type);
  }
}

function isClassified(e: unknown): boolean {
  return e instanceof ApplicationError || e instanceof TransientInfraError || e instanceof UniqueViolationError;
}

/** PROCESSED/REJECTED answer with the balance they observed; undecided (or FAILED) ones with the balance now. */
function resultOf(tx: WagerTransaction, wallet: Wallet, idempotentReplay: boolean): SubmitResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.observedBalance ?? wallet.balance).toJSON(),
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    idempotentReplay,
  };
}
