import { ForbiddenProviderError } from '../../application/errors';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity';
import type { JwtPrincipal } from './keycloak-jwt.guard';

function isJwtPrincipal(principal: unknown): principal is JwtPrincipal {
  return typeof principal === 'object' && principal !== null && typeof (principal as JwtPrincipal).providerId === 'string';
}

/** Spec §9: with Keycloak, a caller may only submit as the provider its token was issued to (`azp`). */
export class JwtProviderIdentity implements ProviderIdentityPort {
  assertMayActAs(providerId: string, principal: unknown): void {
    if (!isJwtPrincipal(principal) || principal.providerId !== providerId) throw new ForbiddenProviderError(providerId);
  }
}
