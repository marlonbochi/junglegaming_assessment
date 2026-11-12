import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

/**
 * Every SQS call is bounded, so a hung socket cannot hold the outbox rows (and their SQL transaction)
 * forever. Without `throwOnRequestTimeout` the SDK only logs a warning. Long polls pass a longer
 * per-call `requestTimeout`.
 */
export const SQS_REQUEST_HANDLER = { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } as const;

/** With an explicit endpoint (LocalStack) the SDK gets static dummy credentials. */
export function createSqsClient(env: Pick<Env, 'AWS_ENDPOINT_URL' | 'AWS_REGION'>): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    requestHandler: { ...SQS_REQUEST_HANDLER },
    ...(env.AWS_ENDPOINT_URL
      ? { endpoint: env.AWS_ENDPOINT_URL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
}

/** Per-call request timeout for a long poll of `waitTimeSeconds`: the wait plus the normal budget. */
export function longPollRequestTimeoutMs(waitTimeSeconds: number): number {
  return waitTimeSeconds * 1000 + SQS_REQUEST_HANDLER.requestTimeout;
}
