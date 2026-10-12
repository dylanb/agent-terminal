import { describe, expect, it } from 'vitest';
import { heldUntil } from '../helpers/heldUntil';

interface Probe {
  step: string;
  turnKey: string;
}

const settled = async <T>(p: Promise<T>): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

describe('heldUntil — hold one matching call of an async seam until the test releases it', () => {
  const real = async (input: Probe): Promise<string> => `real:${input.step}/${input.turnKey}`;
  const isGreen = (input: Probe): boolean => input.step === 'green';

  it('resolves `entered` with the first matching input', async () => {
    const held = heldUntil(real, isGreen);
    void held.seam({ step: 'green', turnKey: 'consolidate-green' });
    await expect(held.entered).resolves.toEqual({ step: 'green', turnKey: 'consolidate-green' });
    held.release();
  });

  it('withholds the matching call’s result until release, then delivers the real result', async () => {
    const held = heldUntil(real, isGreen);
    const call = held.seam({ step: 'green', turnKey: 'k' });
    await held.entered;
    expect(await settled(call)).toBe(false);
    held.release();
    await expect(call).resolves.toBe('real:green/k');
  });

  it('passes a non-matching call straight through without entering or holding', async () => {
    const held = heldUntil(real, isGreen);
    await expect(held.seam({ step: 'red', turnKey: 'k' })).resolves.toBe('real:red/k');
    expect(await settled(held.entered)).toBe(false);
  });

  it('delivers the real rejection to the held caller, only after release', async () => {
    const failing = async (input: Probe): Promise<string> => {
      throw new Error(`boom:${input.step}`);
    };
    const held = heldUntil(failing, isGreen);
    const call = held.seam({ step: 'green', turnKey: 'k' });
    call.catch(() => {});
    await held.entered;
    expect(await settled(call)).toBe(false);
    held.release();
    await expect(call).rejects.toThrow('boom:green');
  });

  it('holds a seam that throws synchronously, delivering the throw only after release', async () => {
    const throwing = (input: Probe): Promise<string> => {
      throw new Error(`sync:${input.step}`);
    };
    const held = heldUntil(throwing, isGreen);
    const call = held.seam({ step: 'green', turnKey: 'k' });
    call.catch(() => {});
    await held.entered;
    expect(await settled(call)).toBe(false);
    held.release();
    await expect(call).rejects.toThrow('sync:green');
  });

  it('passes later matching calls through once the hold has been used', async () => {
    const held = heldUntil(real, isGreen);
    const first = held.seam({ step: 'green', turnKey: 'first' });
    await held.entered;
    const second = held.seam({ step: 'green', turnKey: 'second' });
    await expect(second).resolves.toBe('real:green/second');
    expect(await settled(first)).toBe(false);
    held.release();
    await expect(first).resolves.toBe('real:green/first');
  });

  it('hands the caller’s abort signal to the real function', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const recording = async (_input: Probe, signal?: AbortSignal): Promise<string> => {
      seen.push(signal);
      return 'ok';
    };
    const held = heldUntil(recording, isGreen);
    const controller = new AbortController();
    await held.seam({ step: 'red', turnKey: 'k' }, controller.signal);
    const call = held.seam({ step: 'green', turnKey: 'k' }, controller.signal);
    held.release();
    await call;
    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});
