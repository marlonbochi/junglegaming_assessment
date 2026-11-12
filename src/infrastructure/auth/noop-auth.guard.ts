import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/** Constitution #31: health and metrics never require authentication. */
export function isPublicPath(path: string): boolean {
  return path === '/metrics' || path.startsWith('/health/');
}

/**
 * Spec §9 extension point: lets every request through with no principal. A real guard (Keycloak) keeps
 * the same shape: skip public paths, otherwise authenticate and set `request.principal`.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ path: string; principal?: unknown }>();
    if (isPublicPath(request.path)) return true;
    request.principal = undefined;
    return true;
  }
}
