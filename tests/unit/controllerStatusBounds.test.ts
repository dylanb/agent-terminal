import { afterEach, expect, it, vi } from 'vitest';
import { createControllerDecoder, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import { workStatus } from '../helpers/controllerStatusFixture';

const budget = 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text);
const part = (text: string, last = false) => bytes(JSON.stringify({ version: 1, type: 'status-part', text, last }) + '\n');
afterEach(() => vi.useRealTimers());

it('delivers exactly the accepted UTF-8 snapshot budget and replaces larger snapshots explicitly', () => {
  const base = { version: 1 as const, type: 'status' as const, work: workStatus({ error: { reason: '' } }) };
  const overhead = bytes(JSON.stringify(base)).length;
  const reason = 'é'.repeat(Math.floor((budget - overhead) / 2)) + 'a'.repeat((budget - overhead) % 2);
  const accepted = { ...base, work: workStatus({ error: { reason } }) };
  expect(bytes(JSON.stringify(accepted))).toHaveLength(budget);
  const decoder = createControllerDecoder();
  expect(decoder.push(bytes(encodeControllerMessage(accepted)))).toEqual([accepted]);
  const oversized = { ...base, work: workStatus({ error: { reason: reason + 'a' } }) };
  const [fallback] = decoder.push(bytes(encodeControllerMessage(oversized)));
  expect(fallback).toMatchObject({ type: 'status', work: { unavailableReason: 'message-too-large', flow: { availability: 'unavailable' }, activity: 'unavailable' } });
  expect(decoder.push(bytes(encodeControllerMessage(base)))).toEqual([base]);
});

it('rejects aggregate bytes before retaining an oversized fragment', () => {
  const decoder = createControllerDecoder();
  for (let i = 0; i < 512; i++) decoder.push(part('é'.repeat(1024)));
  expect(() => decoder.push(part('a'))).toThrow();
});

it('rejects empty fragments and bounds fragment count independently of bytes', () => {
  expect(() => createControllerDecoder().push(part(''))).toThrow();
  const decoder = createControllerDecoder();
  for (let i = 0; i < 1024; i++) decoder.push(part('a'));
  expect(() => decoder.push(part('a'))).toThrow();
});

it('expires an incomplete transfer after five seconds even without further input', () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const decoder = createControllerDecoder(expired);
  decoder.push(part('{'));
  vi.advanceTimersByTime(4999);
  decoder.push(part(' '));
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledOnce();
  expect(() => decoder.push(part('}', true))).toThrow();
});

it('cancels deadlines after complete delivery or disposal', () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const decoder = createControllerDecoder(expired);
  const message = { version: 1 as const, type: 'status' as const, work: workStatus() };
  decoder.push(part(JSON.stringify(message), true));
  vi.advanceTimersByTime(5000);
  expect(expired).not.toHaveBeenCalled();
  decoder.push(part('{'));
  decoder.dispose();
  vi.advanceTimersByTime(5000);
  expect(expired).not.toHaveBeenCalled();
});
