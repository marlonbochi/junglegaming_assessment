import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction.types';
import { Wallet } from '../../domain/wallet/wallet';
import { ApplicationError, UniqueViolationError } from '../errors';
import type { Clock, IdGenerator } from '../ports/clock';
import type { Metrics } from '../ports/metrics';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const PLAYER_CURRENCY_UNIQUE = 'wallets_player_id_currency_key';

/** Spec §6.2: wallet, OPENING transaction, its CREDIT entry and WalletBalanceChanged in one SQL transaction. */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletResult> {
    const now = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = this.open(input, openingTransactionId, now);

    try {
      await this.uow.run(async (r) => {
        await r.wallets.insert(wallet);
        if (!openingEntry) return;
        const opening = WagerTransaction.createOpening({
          id: openingTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: wallet.balance,
          now,
        });
        await r.transactions.insert(opening);
        await r.ledger.append(openingEntry);
        const event = WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: this.ids.next(),
          correlationId: input.correlationId,
          causationId: opening.id,
          occurredAt: now,
        });
        await r.outbox.enqueue(OutboxMessage.enqueue(event));
      });
    } catch (e) {
      if (e instanceof UniqueViolationError && e.constraint === PLAYER_CURRENCY_UNIQUE) {
        throw new ApplicationError('WALLET_ALREADY_EXISTS');
      }
      throw e;
    }

    if (openingEntry) this.metrics.transaction(WagerTransactionStatus.Processed, WagerTransactionKind.Opening, 'internal');
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  private open(input: OpenWalletInput, openingTransactionId: string, now: Date) {
    try {
      return Wallet.open({
        id: this.ids.next(),
        playerId: input.playerId,
        initialBalance: Money.from(input.initialBalance),
        openingTransactionId,
        openingEntryId: this.ids.next(),
        now,
      });
    } catch (e) {
      if (e instanceof DomainError) throw new ApplicationError('INVALID_PAYLOAD', e.message);
      throw e;
    }
  }
}
