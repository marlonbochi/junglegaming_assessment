import { describe, expect, test } from 'bun:test';
import { createSqsClient } from '../../../src/infrastructure/sqs/sqs-client';

describe('createSqsClient', () => {
  test('bounds every call: 2s to connect, 5s per request, and a timeout is an error (not just a warning)', async () => {
    const client = createSqsClient({ AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL: 'http://localhost:4566' });
    // The resolved NodeHttpHandler configuration the SDK sends with.
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> };
    expect(await handler.configProvider).toMatchObject({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true });
    client.destroy();
  });
});
