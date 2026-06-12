import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShadowModel, type ShadowStatus } from '../../src/main/shadow';

// Real @xterm/headless, real timers. Thresholds shrunk so quiet transitions
// happen in milliseconds; semantics are identical to the production values.
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
});
