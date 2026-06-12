import { describe, expect, it } from 'vitest';
import { registerIpcListeners, type IpcLike } from '../../src/main/sessionIpc';

type Listener = (...args: unknown[]) => void;

class FakeIpc implements IpcLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly handlers = new Map<string, Listener>();
  on(channel: string, listener: Listener): void {
    const arr = this.listeners.get(channel) ?? [];
    arr.push(listener);
    this.listeners.set(channel, arr);
  }
  removeListener(channel: string, listener: Listener): void {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((l) => l !== listener));
  }
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  emit(channel: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(channel) ?? []) l(...args);
  }
}

describe('registerIpcListeners teardown (§4G — no stale listeners after window close)', () => {
  it('routes events while live and stops routing after dispose', () => {
    const ipc = new FakeIpc();
    const writes: string[] = [];
    const dispose = registerIpcListeners(
      ipc,
      { 'pty:input': (_e, m) => writes.push((m as { data: string }).data) },
      {},
    );

    ipc.emit('pty:input', {}, { data: 'a' });
    expect(writes).toEqual(['a']);

    dispose();
    ipc.emit('pty:input', {}, { data: 'b' });
    expect(writes).toEqual(['a']);
  });

  it('removes invoke handlers on dispose', () => {
    const ipc = new FakeIpc();
    const dispose = registerIpcListeners(ipc, {}, { 'monitor:replay': () => [] });
    expect(ipc.handlers.has('monitor:replay')).toBe(true);
    dispose();
    expect(ipc.handlers.has('monitor:replay')).toBe(false);
  });
});
