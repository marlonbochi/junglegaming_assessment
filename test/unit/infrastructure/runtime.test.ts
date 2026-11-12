import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { TransientInfraError } from '../../../src/application/errors';
import { EnvFaultInjector } from '../../../src/infrastructure/runtime/env-fault-injector';
import { SystemClock } from '../../../src/infrastructure/runtime/system-clock';
import { UuidV7IdGenerator } from '../../../src/infrastructure/runtime/uuid-v7-id-generator';

describe('EnvFaultInjector', () => {
  let exitSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    exitSpy?.mockRestore();
    exitSpy = undefined;
  });

  test('without a spec it never fails', () => {
    const faults = new EnvFaultInjector();
    expect(() => faults.hit('before_commit')).not.toThrow();
  });

  test('throw mode raises a transient error only at the configured point', () => {
    const faults = new EnvFaultInjector('before_commit:throw');
    expect(() => faults.hit('after_ledger_append')).not.toThrow();
    expect(() => faults.hit('before_commit')).toThrow(new TransientInfraError('fault:before_commit'));
    expect(() => faults.hit('before_commit')).toThrow(TransientInfraError);
  });

  test('crash mode exits the process with 137 at the configured point', () => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const faults = new EnvFaultInjector('after_commit_before_ack:crash');

    faults.hit('after_publish_before_mark');
    expect(exitSpy).not.toHaveBeenCalled();
    faults.hit('after_commit_before_ack');
    expect(exitSpy).toHaveBeenCalledWith(137);
  });
});

describe('UuidV7IdGenerator', () => {
  test('generates distinct, time-ordered UUID v7 values', () => {
    const ids = new UuidV7IdGenerator();
    const first = ids.next();
    const second = ids.next();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    expect(second > first).toBe(true);
  });
});

describe('SystemClock', () => {
  test('returns the current time', () => {
    const before = Date.now();
    const at = new SystemClock().now();
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
