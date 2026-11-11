import { TransientInfraError } from '../../application/errors';
import type { FaultInjector, FaultPoint } from '../../application/ports/fault-injector';

/** Exit code of a SIGKILLed process, so an injected crash looks like a real one. */
const CRASH_EXIT_CODE = 137;

/**
 * Test-only fault injection driven by `FAULT="<FaultPoint>:<crash|throw>"` (validated by `loadEnv`).
 * `throw` raises a transient error on purpose: nothing is recorded as FAILED and the message is redelivered.
 */
export class EnvFaultInjector implements FaultInjector {
  private readonly point?: string;
  private readonly mode?: string;

  constructor(spec?: string) {
    [this.point, this.mode] = spec ? spec.split(':') : [];
  }

  hit(point: FaultPoint): void {
    if (point !== this.point) return;
    if (this.mode === 'crash') process.exit(CRASH_EXIT_CODE);
    if (this.mode === 'throw') throw new TransientInfraError(`fault:${point}`);
  }
}
