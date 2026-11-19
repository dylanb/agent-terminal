import { expect, it, vi } from 'vitest';
import { createInjector } from '../../src/main/inject';

it('sanitizes a destination-managed paste and submits separately after the paste', () => {
  vi.useFakeTimers();
  try {
    const pasted: string[] = [];
    const written: string[] = [];
    const destination = { paste: (text: string) => pasted.push(text), write: (text: string) => written.push(text) };
    const inject = createInjector(destination);
    inject('first\nsecond\x1b[201~end', { submit: true });
    expect(pasted).toEqual(['first\rsecondend']);
    expect(written).toEqual([]);
    vi.runAllTimers();
    expect(written).toEqual(['\r']);
  } finally {
    vi.useRealTimers();
  }
});
