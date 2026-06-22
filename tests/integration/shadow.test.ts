import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShadowModel, type ShadowStatus } from '../../src/main/shadow';

// Real @xterm/headless, real timers; thresholds shrunk to milliseconds (semantics unchanged).
const SETTLE_MS = 10;
const QUIET_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(SETTLE_MS * 3);
const goQuiet = () => sleep(QUIET_MS + SETTLE_MS * 3);

describe('shadow screen model (§8)', () => {
  let statuses: ShadowStatus[];
  let shadow: ReturnType<typeof createShadowModel>;

  beforeEach(() => {
    statuses = [];
    shadow = createShadowModel({
      cols: 80,
      rows: 24,
      settleMs: SETTLE_MS,
      quietMs: QUIET_MS,
      onStatus: (s) => statuses.push(s),
    });
  });

  afterEach(() => {
    shadow.dispose();
  });

  it('output flips agentState to active immediately, then quiet after QUIET_MS', async () => {
    shadow.write('hello\r\n');
    expect(statuses.at(0)?.agentState).toBe('active');
    expect(statuses.at(0)?.quietSince).toBeNull();

    await goQuiet();
    const last = statuses.at(-1)!;
    expect(last.agentState).toBe('quiet');
    expect(last.quietSince).toBeTypeOf('number');
  });

  it('tracks bracketed-paste mode from the byte stream (§8.1)', async () => {
    expect(shadow.isBracketedPaste()).toBe(false);
    shadow.write('\x1b[?2004h');
    await settle();
    expect(shadow.isBracketedPaste()).toBe(true);
    expect(statuses.some((s) => s.bracketedPaste)).toBe(true);

    shadow.write('\x1b[?2004l');
    await settle();
    expect(shadow.isBracketedPaste()).toBe(false);
  });

  it('detects alternate-screen enter and exit (§8.1)', async () => {
    shadow.write('\x1b[?1049h');
    await goQuiet();
    expect(statuses.some((s) => s.altScreen)).toBe(true);
    expect(statuses.at(-1)?.altScreen).toBe(true);

    shadow.write('\x1b[?1049l');
    await goQuiet();
    expect(statuses.at(-1)?.altScreen).toBe(false);
  });

  it('publishes only on change — a steady stream produces no duplicate statuses', async () => {
    shadow.write('a');
    shadow.write('b');
    shadow.write('c');
    await goQuiet();
    const count = statuses.length;
    expect(count).toBeGreaterThanOrEqual(2); // active, then quiet
    for (let i = 1; i < statuses.length; i++) {
      expect(statuses[i]).not.toEqual(statuses[i - 1]);
    }
  });

  it('exposes the screen text through its public read path (capture substrate, §8.2)', async () => {
    shadow.write('first line\r\nsecond line\r\n');
    await settle();
    const text = shadow.snapshotText();
    expect(text).toContain('first line');
    expect(text).toContain('second line');
  });

  it('reflows on resize without losing mode state', async () => {
    shadow.write('\x1b[?2004h');
    await settle();
    shadow.resize(120, 30);
    await settle();
    expect(shadow.isBracketedPaste()).toBe(true);
  });

  it('ignores writes and resizes after dispose (§4G — onData can race window close)', () => {
    shadow.dispose();
    expect(() => shadow.write('late output')).not.toThrow();
    expect(() => shadow.resize(100, 40)).not.toThrow();
  });
});

describe('shadow read API for semantic capture (§15.2 / D1)', () => {
  let shadow: ReturnType<typeof createShadowModel>;

  afterEach(() => shadow.dispose());

  function makeShadow(opts: Partial<Parameters<typeof createShadowModel>[0]> = {}) {
    shadow = createShadowModel({
      cols: 80,
      rows: 24,
      settleMs: SETTLE_MS,
      quietMs: QUIET_MS,
      onStatus: () => {},
      ...opts,
    });
    return shadow;
  }

  it('onQuiet fires once per active→quiet transition and observes just-written bytes (settling barrier)', async () => {
    const seen: string[] = [];
    makeShadow();
    shadow.onQuiet(() => seen.push(shadow.snapshotText()));

    shadow.write('hello world');
    await goQuiet();
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('hello world');

    shadow.write('\r\nsecond');
    await goQuiet();
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain('second');
  });

  it('flags wrapped rows so logical lines can be rejoined (§15.2)', async () => {
    makeShadow({ cols: 10 });
    shadow.write('abcdefghijKLMNO'); // 15 cols into a 10-col terminal → row 1 is a wrap
    await settle();
    expect(shadow.reader.isLineWrapped(1)).toBe(true);
    expect(shadow.reader.isLineWrapped(0)).toBe(false);
  });

  it('marker-as-watermark: a marker disposes (line -1) when its row trims past scrollback (D2)', async () => {
    makeShadow({ rows: 5, scrollback: 10 });
    shadow.write('row0\r\n');
    await settle();
    const watermark = shadow.addMarker(0)!;
    expect(watermark).toBeTruthy();
    expect(watermark.line).toBe(0);

    let lines = '';
    for (let i = 1; i <= 50; i++) lines += `r${i}\r\n`;
    shadow.write(lines);
    await settle();
    expect(watermark.line).toBe(-1); // trimmed past scrollback → disposed (conservative truncation, D2)
  });

  it('a marker on a row still in scrollback survives with a shifted line index (D2)', async () => {
    makeShadow({ rows: 5, scrollback: 50 });
    shadow.write('mark-here\r\n');
    await settle();
    const m = shadow.addMarker(0)!;
    shadow.write('a\r\nb\r\nc\r\n');
    await settle();
    expect(m.line).toBe(0); // still within capacity, no trim → not disposed
  });

  it('onOsc(133) receives the payload sans ident, and cursor() inside the handler is the mark position', async () => {
    makeShadow();
    let received: string | null = null;
    let cursorAtMark: { x: number; y: number } | null = null;
    shadow.onOsc(133, (data) => {
      received = data;
      cursorAtMark = shadow.reader.cursor();
    });
    shadow.write('abc\x1b]133;D;0\x07');
    await settle();
    expect(received).toBe('D;0');
    expect(cursorAtMark).toEqual({ x: 3, y: 0 });
  });

  it('addMarker returns undefined on the alternate buffer (markers unsupported there, D1)', async () => {
    makeShadow();
    shadow.write('\x1b[?1049h');
    await settle();
    expect(shadow.reader.bufferType()).toBe('alternate');
    expect(shadow.addMarker(0)).toBeUndefined();
  });
});
