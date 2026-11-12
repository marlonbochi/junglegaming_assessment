import { describe, expect, test } from 'bun:test';
import { ForbiddenProviderError } from '../../../src/application/errors';
import { JwtProviderIdentity } from '../../../src/infrastructure/auth/jwt-provider-identity';

const identity = new JwtProviderIdentity();

describe('JwtProviderIdentity', () => {
  test('the authenticated provider may act as itself', () => {
    expect(() => identity.assertMayActAs('provider-a', { providerId: 'provider-a', subject: 'svc-1' })).not.toThrow();
  });

  test('acting as another provider → ForbiddenProviderError', () => {
    expect(() => identity.assertMayActAs('provider-b', { providerId: 'provider-a' })).toThrow(ForbiddenProviderError);
  });

  test.each([undefined, null, {}, { providerId: 42 }])('a missing or malformed principal (%p) is never trusted', (principal) => {
    expect(() => identity.assertMayActAs('provider-a', principal)).toThrow(ForbiddenProviderError);
  });
});
