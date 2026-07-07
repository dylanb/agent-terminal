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

  it('output flips agentState to active, then quiet after QUIET_MS', async () => {
    shadow.write('hello\r\n');
    await settle();
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

// §8.3 — a full-screen TUI agent (Claude Code, Codex) repaints its frame on a timer even while idle at
// its prompt, so bytes never stop. Byte-presence would pin agentState 'active' forever (the injection
// engine then defers every turn, §26.2). Quiescence keys off *rendered-screen change*, not raw bytes:
// an unchanged repaint is quiet, a changing frame (spinner/stream) is active.
describe('content-diff quiescence for a repainting TUI (§8.3)', () => {
  let statuses: ShadowStatus[];
  let shadow: ReturnType<typeof createShadowModel>;
  const repaint = (frame: string) => `\x1b[2J\x1b[H${frame}`; // clear + home + redraw, as Ink does

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
  afterEach(() => shadow.dispose());

  it('reaches quiet while an unchanged frame keeps repainting faster than QUIET_MS', async () => {
    shadow.write(`\x1b[?1049h${repaint('claude idle ›')}`); // enter alt screen, paint idle frame
    await settle();
    // Keep repainting the SAME frame, faster than QUIET_MS, for well over QUIET_MS total.
    for (let i = 0; i < 8; i++) {
      shadow.write(repaint('claude idle ›'));
      await sleep(QUIET_MS / 2); // byte-presence would re-arm the quiet timer here every half-window
    }
    // Content never changed after the first frame → quiet must have been reached mid-repaint.
    expect(statuses.some((s) => s.agentState === 'quiet')).toBe(true);
    expect(statuses.at(-1)?.agentState).toBe('quiet');
  });

  it('stays active while the frame keeps changing (spinner / streaming)', async () => {
    const frames = ['⠋ working', '⠙ working', '⠹ working', '⠸ working'];
    shadow.write('\x1b[?1049h');
    await settle();
    for (let i = 0; i < 8; i++) {
      shadow.write(repaint(frames[i % frames.length]));
      await sleep(QUIET_MS / 2);
    }
    expect(statuses.at(-1)?.agentState).toBe('active');
  });
});

// §26.3 stall watchdog — the turn runner resets its stall deadline on every *visible-content change*
// edge (the same §8.3 signal that reaches quiescence), so a streaming turn never stalls but a frozen
// screen counts down. onActivity exposes that edge; an identical repaint is NOT an edge.
describe('shadow.onActivity — fires per visible-content-change edge (§26.3)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  const repaint = (frame: string) => `\x1b[2J\x1b[H${frame}`;

  beforeEach(() => {
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: SETTLE_MS, quietMs: QUIET_MS, onStatus: () => {} });
  });
  afterEach(() => shadow.dispose());

  it('fires on a changed frame but NOT on an identical repaint', async () => {
    let hits = 0;
    shadow.onActivity(() => hits++);
    shadow.write(`\x1b[?1049h${repaint('frame one')}`);
    await settle();
    const afterFirst = hits;
    expect(afterFirst).toBeGreaterThan(0); // the initial paint is an edge

    shadow.write(repaint('frame one')); // identical → no edge
    await settle();
    expect(hits).toBe(afterFirst);

    shadow.write(repaint('frame two')); // changed → one edge
    await settle();
    expect(hits).toBe(afterFirst + 1);
  });

  it('stops firing after the returned unsubscribe', async () => {
    let hits = 0;
    const off = shadow.onActivity(() => hits++);
    shadow.write('a');
    await settle();
    const n = hits;
    expect(n).toBeGreaterThan(0);
    off();
    shadow.write('bc');
    await settle();
    expect(hits).toBe(n);
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
