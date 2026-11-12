import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type pino from 'pino';
import { summarizeError } from '../../application/error-summary';
import { PermanentInfraError, TransientInfraError } from '../../application/errors';
import { requestContext } from '../../infrastructure/observability/request-context';
import type { HttpResponse } from './http-types';
import { FailedTransactionError, PROBLEM_CONTENT_TYPE, toProblem } from './problem-details';

/** Every error, Nest's own included, leaves as application/problem+json. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: pino.Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    const correlationId = requestContext.getStore()?.correlationId ?? 'unknown';
    const problem = toProblem(error, correlationId);
    this.log(error, problem.status);
    for (const [name, value] of Object.entries(problem.headers)) res.setHeader(name, value);
    res.status(problem.status).setHeader('content-type', PROBLEM_CONTENT_TYPE);
    res.end(JSON.stringify(problem.body));
  }

  private log(error: unknown, status: number): void {
    if (status < 500) return;
    const err = describe(error);
    if (error instanceof TransientInfraError) this.logger.warn({ err }, 'transient infrastructure failure');
    else if (error instanceof FailedTransactionError) this.logger.warn({ err }, 'replayed transaction is FAILED');
    // The cause is often a driver error whose message embeds row values: name, SQLSTATE and constraint only.
    else if (error instanceof PermanentInfraError) this.logger.error({ err, cause: summarizeError(error.cause) }, 'permanent failure');
    else this.logger.error({ err }, 'unhandled error');
  }
}

/** Name, message and stack only: driver errors carry row details (amounts) in other fields. */
function describe(error: unknown): { type: string; message: string; stack?: string } | undefined {
  if (error === undefined) return undefined;
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  return { type: error.name, message: error.message, stack: error.stack };
}
