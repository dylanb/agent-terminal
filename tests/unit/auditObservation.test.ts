import { afterEach, expect, it, vi } from 'vitest';
import { createAuditObservation } from '../../src/main/auditObservation';

afterEach(() => { vi.useRealTimers(); });

it('allows close and cancels discovery when an audit observation remains pending', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const observations = createAuditObservation({ observe: () => new Promise<void>(() => {}), cancel: () => controller.abort() });
  let closed = false;
  const closing = observations.close().then(() => { closed = true; });
  expect(closed).toBe(false);
  await vi.runOnlyPendingTimersAsync();
  await closing;
  expect(closed).toBe(true);
  expect(controller.signal.aborted).toBe(true);
});

it('flushes an earlier turn even if the final observation has nothing left to discover', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let earlier = true;
  const controller = new AbortController();
  const observations = createAuditObservation({ observe: () => {
    if (!earlier) return Promise.resolve();
    earlier = false;
    return new Promise<void>(resolve => { finish = resolve; });
  }, cancel: () => controller.abort() });
  const recording = observations.observe();
  let closed = false;
  const closing = observations.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await recording;
  await closing;
  expect(closed).toBe(true);
  await vi.runOnlyPendingTimersAsync();
  expect(controller.signal.aborted).toBe(false);
});

it.each(['throw', 'reject'] as const)('allows close when discovery fails by %s', async failure => {
  vi.useFakeTimers();
  const observations = createAuditObservation({ observe: () => {
    if (failure === 'throw') throw new Error('unavailable transcript');
    return Promise.reject(new Error('unavailable transcript'));
  }, cancel: () => {} });
  await expect(observations.close()).resolves.toBeUndefined();
});

it('allows close even when cancelling discovery fails', async () => {
  vi.useFakeTimers();
  const observations = createAuditObservation({ observe: () => new Promise<void>(() => {}), cancel: () => { throw new Error('cancellation failed'); } });
  const closing = observations.close();
  await vi.runOnlyPendingTimersAsync();
  await expect(closing).resolves.toBeUndefined();
});


it('preserves failure reasons without repeating the same polling error until recovery', async () => {
  vi.useFakeTimers();
  const messages: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
  let failed = true;
  const observations = createAuditObservation({ observe: () => failed ? Promise.reject('observation failed') : Promise.resolve(), cancel: () => {} });
  try {
    await observations.observe();
    await observations.observe();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('observation failed');
    failed = false;
    await observations.observe();
    failed = true;
    await observations.observe();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('observation failed');
  } finally { log.mockRestore(); }
});

it.each(['throw', 'cancel'] as const)('records the reason for an unexpected %s failure', async failure => {
  vi.useFakeTimers();
  const messages: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
  const observations = createAuditObservation({ observe: () => {
    if (failure === 'throw') throw 'observation failed';
    return new Promise<void>(() => {});
  }, cancel: () => { throw 'cancellation failed'; } });
  try {
    const closing = observations.close();
    await vi.runOnlyPendingTimersAsync();
    await closing;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(failure === 'throw' ? 'observation failed' : 'cancellation failed');
  } finally { log.mockRestore(); }
});
