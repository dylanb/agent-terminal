import { describe, it, expect, vi } from 'vitest';
import { createBaseWarmer } from '../../src/main/artifactTree';

// §20.1: the glue that fires the viewer re-pull once the off-thread base warm reveals a different base.
describe('createBaseWarmer', () => {
  it('fires onChanged when warming reports the base changed', async () => {
    const onChanged = vi.fn();
    await createBaseWarmer({ root: () => '/repo', warm: async () => true, onChanged })();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChanged when the base is unchanged', async () => {
    const onChanged = vi.fn();
    await createBaseWarmer({ root: () => '/repo', warm: async () => false, onChanged })();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('skips warming (and onChanged) outside a repo', async () => {
    const onChanged = vi.fn();
    const warm = vi.fn(async () => true);
    await createBaseWarmer({ root: () => null, warm, onChanged })();
    expect(warm).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('swallows a warming failure without firing onChanged (best-effort, never aborts the caller)', async () => {
    const onChanged = vi.fn();
    const warm = createBaseWarmer({
      root: () => '/repo',
      warm: async () => { throw new Error('boom'); },
      onChanged,
    });
    await expect(warm()).resolves.toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
