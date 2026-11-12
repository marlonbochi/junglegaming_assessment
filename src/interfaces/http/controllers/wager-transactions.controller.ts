import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../../application/ports/provider-identity';
import { GetTransaction, type TransactionView } from '../../../application/use-cases/get-transaction';
import { SubmitWagerTransaction, type SubmitResult } from '../../../application/use-cases/submit-wager-transaction';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction.types';
import { enrichRequestContext } from '../../../infrastructure/observability/request-context';
import type { HttpRequest, HttpResponse } from '../http-types';
import { FailedTransactionError } from '../problem-details';
import { currentCorrelationId } from '../request-context.middleware';
import { idempotencyKeyHeader, submitWagerBody, textParam, uuidParam, type SubmitWagerBody } from '../schemas';
import { PROVIDER_IDENTITY } from '../../tokens';
import { ZodValidationPipe } from '../zod-validation.pipe';

/** Spec §7: the HTTP status follows the decided status; FAILED only reaches here on replay. */
const STATUS_CODES: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
};

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeyHeader, 'MISSING_IDEMPOTENCY_KEY');

@Controller()
export class WagerTransactionsController {
  constructor(
    private readonly submitWager: SubmitWagerTransaction,
    private readonly getTransaction: GetTransaction,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body(new ZodValidationPipe(submitWagerBody)) body: SubmitWagerBody,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<SubmitResult> {
    const idempotencyKey = idempotencyKeyPipe.transform(req.headers['idempotency-key']);
    enrichRequestContext({ walletId: body.walletId, providerId: body.providerId });
    this.identity.assertMayActAs(body.providerId, req.principal);

    const result = await this.submitWager.execute({ ...body, idempotencyKey }, { type: 'http' }, currentCorrelationId());
    enrichRequestContext({ transactionId: result.transactionId });
    if (result.idempotentReplay) res.setHeader('Idempotent-Replayed', 'true');

    const status = STATUS_CODES[result.status];
    if (status === undefined) throw new FailedTransactionError(result.transactionId);
    res.status(status);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ZodValidationPipe(uuidParam)) id: string): Promise<TransactionView> {
    enrichRequestContext({ transactionId: id });
    return this.getTransaction.byId(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId', new ZodValidationPipe(textParam)) providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(textParam)) externalTransactionId: string,
  ): Promise<TransactionView> {
    enrichRequestContext({ providerId });
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
