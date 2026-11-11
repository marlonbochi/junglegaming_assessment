export interface ProviderIdentityPort {
  assertMayActAs(providerId: string, principal: unknown): void;
}
