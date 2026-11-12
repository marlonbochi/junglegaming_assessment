import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { TransientInfraError, UnauthenticatedError } from '../../application/errors';
import { isPublicPath } from './noop-auth.guard';

/** Every provider client in the realm carries an audience mapper that adds this to its tokens. */
export const WAGERING_API_AUDIENCE = 'wagering-api';

/** What a verified token tells us about the caller: the Keycloak client (`azp`) is the provider. */
export interface JwtPrincipal {
  providerId: string;
  subject?: string;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** jose failures that mean "this token is not acceptable"; anything else is the key set failing us. */
const TOKEN_REJECTIONS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

/**
 * Spec §9 optional auth: verifies `Authorization: Bearer <JWT>` against the realm's JWKS (signature, `iss`,
 * `aud`, `exp`) and sets `request.principal`. Same shape as `NoopAuthGuard`: public paths are skipped (C#31).
 * An unreachable key set is a 503 (retryable), not a 401 that would blame the caller's credentials.
 */
@Injectable()
export class KeycloakJwtGuard implements CanActivate {
  constructor(
    private readonly issuer: string,
    private readonly keys: JWTVerifyGetKey,
  ) {}

  /** Production wiring: keys fetched from `jwksUrl`, cached and refreshed by jose on unknown `kid`. */
  static remote(issuer: string, jwksUrl: string): KeycloakJwtGuard {
    return new KeycloakJwtGuard(issuer, createRemoteJWKSet(new URL(jwksUrl)));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ path: string; headers: Record<string, string | string[] | undefined>; principal?: unknown }>();
    if (isPublicPath(request.path)) return true;

    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    if (token === undefined) throw new UnauthenticatedError('Missing bearer token');

    request.principal = await this.verify(token);
    return true;
  }

  private async verify(token: string): Promise<JwtPrincipal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: WAGERING_API_AUDIENCE,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      });
      if (typeof payload.azp !== 'string' || payload.azp === '') throw new UnauthenticatedError('Token has no azp claim');
      return { providerId: payload.azp, subject: payload.sub };
    } catch (error) {
      if (error instanceof UnauthenticatedError) throw error;
      if (TOKEN_REJECTIONS.some((rejection) => error instanceof rejection)) throw new UnauthenticatedError('Invalid or expired token');
      throw new TransientInfraError('identity provider key set unavailable', { cause: error });
    }
  }
}
