import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createCommandTracker, type CommandTracker } from '../../src/main/commandTracker';
import { resolveRuntimeConfig, type RuntimeConfig } from '../../src/main/runtimeConfig';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const osc = (s: string) => `\x1b]${s}\x07`;

/** One full OSC-133 command cycle: prompt + command-start, command echo, output-start, output, finish. */
function runCmd(command: string, output: string, exit: number, prompt = '$ '): string {
  return (
    osc('133;A') +
    prompt +
    osc('133;B') +
    command +
    '\r\n' +
    osc('133;C') +
    output +
    osc(`133;D;${exit}`)
  );
}

describe('command tracker (§15.5 — OSC 133 segmentation, detection only)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let tracker: CommandTracker;

  function setup(cfg: Partial<RuntimeConfig> = {}, cols = 80, scrollback = 5000) {
    shadow = createShadowModel({ cols, rows: 24, scrollback, settleMs: 5, quietMs: 20, onStatus: () => {} });
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: { ...resolveRuntimeConfig({}), ...cfg },
    });
  }

  afterEach(() => {
    tracker.dispose();
    shadow.dispose();
  });

  it('summarizes command text, exit code, and running state', async () => {
    setup();
    shadow.write(runCmd('echo hi', 'hi\r\n', 0));
    await sleep(60);
    const s = tracker.summaries();
    expect(s.length).toBe(1);
    expect(s[0].command).toBe('echo hi');
    expect(s[0].exitCode).toBe(0);
    expect(s[0].running).toBe(false);
    expect(s[0].truncated).toBe(false);
  });

  it('clear() drops finished commands and fires a change (§15.5, tracker-internal)', async () => {
    setup();
    shadow.write(runCmd('echo hi', 'hi\r\n', 0));
    await sleep(60);
    expect(tracker.summaries().length).toBe(1);
    let changed = 0;
    tracker.onChange(() => changed++);
    tracker.clear();
    expect(tracker.summaries()).toEqual([]);
    expect(changed).toBe(1);
  });

  it('clear() keeps a still-running command, dropping only finished ones (§16.2)', async () => {
    setup();
    shadow.write(runCmd('echo done', 'x\r\n', 0)); // finished
    shadow.write(osc('133;A') + '$ ' + osc('133;B') + 'tail -f\r\n' + osc('133;C') + 'live\r\n'); // running, no D
    await sleep(60);
    expect(tracker.summaries().map((c) => c.command)).toEqual(['echo done', 'tail -f']);
    tracker.clear();
    const s = tracker.summaries();
    expect(s.map((c) => c.command)).toEqual(['tail -f']);
    expect(s[0].running).toBe(true);
  });

  it('captures a finished command output on demand', async () => {
    setup();
    shadow.write(runCmd('echo hi', 'hi\r\n', 0));
    await sleep(60);
    const id = tracker.summaries()[0].id;
    expect(tracker.capture(id)?.text).toBe('hi');
  });

  it('newest-last ordering and non-zero exit codes', async () => {
    setup();
    shadow.write(runCmd('true', '', 0));
    shadow.write(runCmd('false', '', 1));
    await sleep(60);
    const s = tracker.summaries();
    expect(s.map((c) => c.command)).toEqual(['true', 'false']);
    expect(s[1].exitCode).toBe(1);
  });

  it('an open span (no D yet) is capturable as "output so far"', async () => {
    setup();
    shadow.write(osc('133;A') + '$ ' + osc('133;B') + 'tail -f\r\n' + osc('133;C') + 'line1\r\nline2\r\n');
    await sleep(60);
    const s = tracker.summaries();
    expect(s[0].running).toBe(true);
    expect(s[0].exitCode).toBeNull();
    expect(tracker.capture(s[0].id)?.text).toBe('line1\nline2');
  });

  it('ignores a stray first D with no open span (A4)', async () => {
    setup();
    shadow.write(osc('133;D;0') + osc('133;A') + '$ ' + osc('133;B'));
    await sleep(60);
    expect(tracker.summaries().length).toBe(0);
  });

  it('rejoins a wrapped command line', async () => {
    setup({}, 10);
    // "echo abcdefgh" is 13 chars; after the "$ " prompt it wraps the 10-col row.
    shadow.write(runCmd('echo abcdefgh', 'x\r\n', 0));
    await sleep(60);
    expect(tracker.summaries()[0].command).toBe('echo abcdefgh');
  });

  it('onChange fires on command start and finish', async () => {
    setup();
    const events: string[] = [];
    tracker.onChange(() => events.push('change'));
    shadow.write(osc('133;A') + '$ ' + osc('133;B') + 'echo hi\r\n' + osc('133;C'));
    await sleep(60);
    const afterStart = events.length;
    expect(afterStart).toBeGreaterThanOrEqual(1);
    shadow.write('hi\r\n' + osc('133;D;0'));
    await sleep(60);
    expect(events.length).toBeGreaterThan(afterStart);
  });

  // ---- Adversarial ordering (threat model: marks are untrusted) ----

  it('B after B re-opens the command-start at the newer B', async () => {
    setup();
    shadow.write(
      osc('133;A') + '$ ' + osc('133;B') + 'XX' + osc('133;B') + 'realcmd\r\n' + osc('133;C') + 'o\r\n' + osc('133;D;0'),
    );
    await sleep(60);
    const s = tracker.summaries();
    expect(s.length).toBe(1);
    expect(s[0].command).toBe('realcmd');
  });

  it('C without a preceding B is ignored (no span, no crash)', async () => {
    setup();
    expect(() => shadow.write(osc('133;C') + 'orphan\r\n' + osc('133;D;0'))).not.toThrow();
    await sleep(60);
    expect(tracker.summaries().length).toBe(0);
  });

  it('drops marks while the alternate buffer is active (no crash)', async () => {
    setup();
    shadow.write('\x1b[?1049h');
    await sleep(60);
    expect(() => shadow.write(runCmd('echo hi', 'hi\r\n', 0))).not.toThrow();
    await sleep(60);
    expect(tracker.summaries().length).toBe(0);
  });

  // ---- Resource bounds (CWE-400) ----

  it('clamps over-long output to maxExtractedRows and stamps truncated', async () => {
    setup({ maxExtractedRows: 3 });
    let out = '';
    for (let i = 0; i < 20; i++) out += `out${i}\r\n`;
    shadow.write(runCmd('seq', out, 0));
    await sleep(60);
    const cap = tracker.capture(tracker.summaries()[0].id)!;
    expect(cap.truncated).toBe(true);
    expect(cap.text.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('caps concurrent open spans, evicting oldest-first and disposing its markers', async () => {
    setup({ maxOpenSpans: 2 });
    // Count live markers through the injected addMarker seam — a test-owned wrapper, not a mutated
    // real IMarker.
    let live = 0;
    tracker.dispose();
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => {
        const m = shadow.addMarker(r);
        if (!m) return m;
        live++;
        const wrapper = {
          get id() {
            return m.id;
          },
          get line() {
            return m.line;
          },
          dispose() {
            live--;
            m.dispose();
          },
        };
        return wrapper as unknown as typeof m;
      },
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: { ...resolveRuntimeConfig({}), maxOpenSpans: 2 },
    });
    // Open three commands without closing any (no D) → first must be evicted.
    const openOnly = (c: string) => osc('133;A') + '$ ' + osc('133;B') + c + '\r\n' + osc('133;C');
    shadow.write(openOnly('a') + openOnly('b') + openOnly('c'));
    await sleep(60);
    expect(tracker.summaries().map((c) => c.command)).toEqual(['b', 'c']);
    // The evicted span's markers were disposed, not leaked: 3 commands × 1 retained
    // output marker each, minus the evicted one ⇒ fewer live markers than created.
    expect(live).toBeLessThan(3);
  });

  it('retains at most maxCommandSummaries, dropping oldest', async () => {
    setup({ maxCommandSummaries: 2 });
    shadow.write(runCmd('one', '', 0));
    shadow.write(runCmd('two', '', 0));
    shadow.write(runCmd('three', '', 0));
    await sleep(60);
    expect(tracker.summaries().map((c) => c.command)).toEqual(['two', 'three']);
  });

  it('fail-closed: capturing an unknown id returns undefined', async () => {
    setup();
    shadow.write(runCmd('echo hi', 'hi\r\n', 0));
    await sleep(60);
    expect(tracker.capture('no-such-id')).toBeUndefined();
  });
});
