import type { ProviderIdentityPort } from '../../application/ports/provider-identity';

/** Spec §9: without an identity provider every caller may act as any provider. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  assertMayActAs(_providerId: string, _principal: unknown): void {}
}
