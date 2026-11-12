import { expect, test } from 'bun:test';
import { eventually } from '../../support/eventually';

test('resolves once fn stops throwing', async () => {
  let calls = 0;
  const v = await eventually(async () => { if (++calls < 3) throw new Error('nope'); return 'ok'; }, { intervalMs: 1 });
  expect(v).toBe('ok'); expect(calls).toBe(3);
});
test('rethrows last error after timeout', async () => {
  await expect(eventually(async () => { throw new Error('still failing'); }, { timeoutMs: 50, intervalMs: 5 }))
    .rejects.toThrow('still failing');
});
