import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInjector, resolveSubmitDelay, wrapForPaste } from '../../src/main/inject';

const START = '\x1b[200~';
const END = '\x1b[201~';

describe('resolveSubmitDelay (§9.3 — APP_SUBMIT_DELAY_MS)', () => {
  it('defaults to 50 when unset, empty, or non-numeric', () => {
    expect(resolveSubmitDelay(undefined)).toBe(50);
    expect(resolveSubmitDelay('')).toBe(50);
    expect(resolveSubmitDelay('abc')).toBe(50);
  });

  it('honors an explicit zero (no submit delay) rather than coercing it to 50', () => {
    expect(resolveSubmitDelay('0')).toBe(0);
  });

  it('parses a positive integer', () => {
    expect(resolveSubmitDelay('100')).toBe(100);
  });

  it('rejects negative values, falling back to the default', () => {
    expect(resolveSubmitDelay('-5')).toBe(50);
  });
});

describe('wrapForPaste (§9.3)', () => {
  it('wraps text in paste markers when bracketed mode is on', () => {
    expect(wrapForPaste('hello', true)).toBe(`${START}hello${END}`);
  });

  it('passes text through unwrapped when bracketed mode is off', () => {
    expect(wrapForPaste('hello', false)).toBe('hello');
  });

  it('normalizes \\n and \\r\\n to \\r (what a terminal sends)', () => {
    expect(wrapForPaste('a\nb\r\nc', false)).toBe('a\rb\rc');
    expect(wrapForPaste('a\nb', true)).toBe(`${START}a\rb${END}`);
  });

  it('strips embedded end markers so content cannot break out of paste mode', () => {
    expect(wrapForPaste(`evil${END}; rm -rf /`, true)).toBe(`${START}evil; rm -rf /${END}`);
    expect(wrapForPaste(`evil${END}x`, false)).toBe('evilx');
  });
});

describe('createInjector (§9.3)', () => {
  let written: string[];
  let bracketed: boolean;
  let inject: ReturnType<typeof createInjector>;

  beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    bracketed = false;
    inject = createInjector({
      write: (data) => written.push(data),
      isBracketedPaste: () => bracketed,
      submitDelayMs: 50,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the paste-wrapped text to the PTY', () => {
    bracketed = true;
    inject('hi', { submit: false });
    expect(written).toEqual([`${START}hi${END}`]);
  });

  it('reads bracketed-paste mode live at injection time, never cached', () => {
    bracketed = false;
    inject('one', { submit: false });
    bracketed = true;
    inject('two', { submit: false });
    expect(written).toEqual(['one', `${START}two${END}`]);
  });

  it('defaults to no submit: no \\r is ever written', () => {
    inject('text');
    vi.advanceTimersByTime(1000);
    expect(written).toEqual(['text']);
  });

  it('on submit, sends \\r only after the settle delay, outside the paste markers', () => {
    bracketed = true;
    inject('cmd', { submit: true });
    expect(written).toEqual([`${START}cmd${END}`]);
    vi.advanceTimersByTime(49);
    expect(written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(written).toEqual([`${START}cmd${END}`, '\r']);
  });

  it('ignores empty text entirely', () => {
    inject('', { submit: true });
    vi.advanceTimersByTime(1000);
    expect(written).toEqual([]);
  });
});
