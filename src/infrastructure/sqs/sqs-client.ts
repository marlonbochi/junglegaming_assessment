import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

/** With an explicit endpoint (LocalStack) the SDK gets static dummy credentials. */
export function createSqsClient(env: Pick<Env, 'AWS_ENDPOINT_URL' | 'AWS_REGION'>): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL
      ? { endpoint: env.AWS_ENDPOINT_URL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
}
