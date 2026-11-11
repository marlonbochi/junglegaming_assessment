import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { GetWallet, type WalletView } from '../../../application/use-cases/get-wallet';
import { ListLedger, type LedgerPage } from '../../../application/use-cases/list-ledger';
import { OpenWallet, type OpenWalletResult } from '../../../application/use-cases/open-wallet';
import { ReconcileWallet, type ReconciliationResult } from '../../../application/use-cases/reconcile-wallet';
import { enrichRequestContext } from '../../../infrastructure/observability/request-context';
import { currentCorrelationId } from '../request-context.middleware';
import { ledgerQuery, openWalletBody, uuidParam } from '../schemas';
import { ZodValidationPipe } from '../zod-validation.pipe';

const walletId = () => new ZodValidationPipe(uuidParam);

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  async open(@Body(new ZodValidationPipe(openWalletBody)) body: z.infer<typeof openWalletBody>): Promise<OpenWalletResult> {
    const result = await this.openWallet.execute({ ...body, correlationId: currentCorrelationId() });
    enrichRequestContext({ walletId: result.id });
    return result;
  }

  @Get(':walletId')
  get(@Param('walletId', walletId()) id: string): Promise<WalletView> {
    enrichRequestContext({ walletId: id });
    return this.getWallet.execute(id);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', walletId()) id: string,
    @Query(new ZodValidationPipe(ledgerQuery)) query: z.infer<typeof ledgerQuery>,
  ): Promise<LedgerPage> {
    enrichRequestContext({ walletId: id });
    return this.listLedger.execute(id, query.cursor, query.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', walletId()) id: string): Promise<ReconciliationResult> {
    enrichRequestContext({ walletId: id });
    return this.reconcileWallet.execute(id);
  }
}
