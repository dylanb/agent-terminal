import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmit } from '../../src/main/scanner';
import { createInjector } from '../../src/main/inject';
import { createInjectionSuppressor } from '../../src/main/injectionSuppression';
import { createGenericAdapter } from '../../src/main/adapters/generic';
import type { Adapter } from '../../src/main/adapters/types';
import type { CommandSpanRange } from '../../src/main/spanTypes';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous margins: vitest runs files in parallel workers, so setTimeout-based
// quiet transitions can be delayed well past quietMs under CPU contention.
const SETTLE = 10;
const QUIET = 40;
const goQuiet = () => sleep(220);

// Trivial injected adapter (config injection, NOT an emulator mock — §15.8):
// every line ending in '?' within the scan window becomes one region. The type is
// irrelevant to the watermark/dedup mechanics under test here.
const lineAdapter: Adapter = {
  id: 'test-line',
  detect: ({ reader, startRow, endRow }) => {
    const out = [];
    for (let y = startRow; y <= endRow; y++) {
      const t = reader.lineText(y).trim();
      if (t.endsWith('?')) {
        out.push({ type: 'report' as const, source: 'shadow-scan' as const, text: t, startRow: y, endRow: y });
      }
    }
    return out;
  },
};

describe('semantic scanner (§15.2/§15.3 — quiet-triggered, watermarked, deduped)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let emitted: Parameters<ScannerEmit>[0][];

  const collectingEmit: ScannerEmit = (e) => {
    emitted.push(e);
    return String(emitted.length);
  };

  function setup(scrollback = 5000, rows = 24) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows, scrollback, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [lineAdapter],
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
    });
  }

  afterEach(() => shadow?.dispose());

  it('is stored as plain text, not a NUL-containing binary blob', () => {
    // A NUL (or other control byte) in the source makes git treat the file as
    // binary, destroying diff/blame/merge for the central scanner module.
    const bytes = readFileSync(path.resolve(__dirname, '../../src/main/scanner.ts'));
    const offending = bytes.findIndex((b) => b === 0 || (b < 9) || (b > 13 && b < 32));
    expect(offending, `control byte 0x${bytes[offending]?.toString(16)} at offset ${offending}`).toBe(-1);
  });

  it('emits only on the quiet transition, never per output chunk', async () => {
    setup();
    shadow.write('Do you want to continue?\r\n');
    expect(emitted.length).toBe(0); // still active — no scan yet
    await goQuiet();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toMatchObject({ type: 'report', text: 'Do you want to continue?', parentId: null });
  });

  it('consults the live chrome-marker profile so a newly-learned glyph filters future furniture (§15.x)', async () => {
    // Acceptance for "mark as chrome": once a custom glyph is learned, lines led by it
    // stop being captured. Driven through the real generic adapter (which respects the
    // scanner-supplied isChrome) so the assertion is on emitted events, not internals.
    emitted = [];
    const markers: string[] = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
      chromeMarkers: () => markers,
    });

    // Before learning, a block led by the custom glyph ◆ is captured (◆ is unknown).
    shadow.write(
      '◆ the custom themed status glyph shows progress and elapsed time as it works\r\n' +
        '◆ and a second custom-glyph line keeps the running token and context in view\r\n',
    );
    await goQuiet();
    expect(emitted.length).toBe(1);
    expect(emitted[0].text).toContain('custom themed status glyph');

    // The user marks it as chrome; the profile now yields ◆.
    markers.push('◆');
    shadow.write(
      '◆ a completely different custom-glyph status line appears on the next scan now\r\n' +
        '◆ with more custom-glyph furniture text that would also exceed the threshold ok\r\n',
    );
    await goQuiet();
    expect(emitted.length).toBe(1); // the new ◆ furniture is filtered, not captured
  });

  it('dedups an unchanged region across repeated quiet transitions', async () => {
    setup();
    shadow.write('Continue?\r\n');
    await goQuiet();
    expect(emitted.length).toBe(1);
    shadow.write('\r\n'); // new activity, but the region is unchanged
    await goQuiet();
    expect(emitted.length).toBe(1);
  });

  it('emits only the newly-appeared region when content is appended', async () => {
    setup();
    shadow.write('First?\r\n');
    await goQuiet();
    shadow.write('Second?\r\n');
    await goQuiet();
    expect(emitted.map((e) => e.text)).toEqual(['First?', 'Second?']);
  });

  it('stamps truncated:true when scrollback trims past the watermark', async () => {
    setup(10, 5);
    shadow.write('Q1?\r\n');
    await goQuiet();
    expect(emitted[0].truncated).toBe(false);
    let flood = '';
    for (let i = 0; i < 60; i++) flood += `noise${i}\r\n`;
    shadow.write(flood + 'Q2?\r\n');
    await goQuiet();
    const q2 = emitted.find((e) => e.text === 'Q2?')!;
    expect(q2.truncated).toBe(true);
  });

  function setupGeneric(closed: CommandSpanRange[] = [], reportMinChars = 20) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [], // no specific adapter matches → degrade to the generic fallback (§15.3)
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars,
      closedSpans: () => closed,
      emit: collectingEmit,
    });
  }

  it('degrades to the generic fallback: a long new region becomes one heuristic report with linked findings', async () => {
    setupGeneric();
    shadow.write('- principal needs a fix\r\n- security needs a fix\r\n\r\nThis is the closing note.\r\n');
    await goQuiet();
    const reports = emitted.filter((e) => e.type === 'report');
    expect(reports.length).toBe(1);
    expect(reports[0].source).toBe('heuristic');
    expect(reports[0].parentId).toBeNull();
    const findings = emitted.filter((e) => e.type === 'finding');
    expect(findings.length).toBe(3);
    expect(findings.every((f) => f.parentId === String(1))).toBe(true); // first emitted id
  });

  it('does not emit a report for short below-threshold output', async () => {
    setupGeneric([], 500);
    shadow.write('ok done\r\n');
    await goQuiet();
    expect(emitted).toEqual([]);
  });

  it('skips content that falls inside a closed command-output span so no report forms (§15.6)', async () => {
    setupGeneric([{ startRow: 0, endRow: 5 }]);
    shadow.write('- principal needs a fix\r\n- security needs a fix\r\n');
    await goQuiet();
    expect(emitted).toEqual([]);
  });

  it('does not re-emit a report for stable (unchanged) chrome on the next scan', async () => {
    setupGeneric();
    shadow.write('- principal needs a fix\r\n- security needs a fix\r\n\r\nThis is the closing note.\r\n');
    await goQuiet();
    const first = emitted.length;
    expect(first).toBeGreaterThan(0);
    shadow.write('\r\n'); // no new content, prior lines stable
    await goQuiet();
    expect(emitted.length).toBe(first);
  });

  it('does not re-emit a report each tick when a contiguous trailing line mutates (§15.3)', async () => {
    // The inverted baseline gathers a free-form prose run; a live-updating line that
    // sits contiguous with a report (a progress/elapsed line, or composer text with no
    // rule/marker boundary above it) makes the run's text differ every quiet tick. That
    // is not a clean append, so prefix-retraction misses it — without tail-mutation
    // dedup it re-captures the same report over and over.
    setupGeneric();
    const body = 'principal: pin the spec version\r\nsecurity: lock down redirects\r\n';
    const tail = (s: string) => `working on the follow-up, progress ${s} so far\r\n`;
    shadow.write(body + tail('10pct'));
    await goQuiet();
    shadow.write('\x1b[1A\r' + tail('20pct')); // repaint the trailing line in place
    await goQuiet();
    shadow.write('\x1b[1A\r' + tail('30pct'));
    await goQuiet();
    const reports = emitted.filter((e) => e.type === 'report');
    expect(reports).toHaveLength(1);
  });

  it('never re-emits a report once its rows are processed, even if they are rewritten in place (§15.3 positional)', async () => {
    // The durable guarantee the user asked for: a captured paragraph's buffer position is
    // marked processed and never revisited. An EARLY token mutating (3s→5s→7s) defeats
    // exact/prefix/tail-mutation content dedup (common prefix is only "Status "), so this
    // only stays at one capture if the scanner refuses to re-scan processed rows at all.
    setupGeneric();
    const report = (t: string) =>
      `Status ${t}: the review is complete, all findings are listed below\r\n` +
      `Finding: the auth flow looks sound and migration is well covered\r\n`;
    shadow.write(report('3s'));
    await goQuiet();
    expect(emitted.filter((e) => e.type === 'report')).toHaveLength(1);
    // Agent repaints the same two rows in place with an updated early token.
    shadow.write('\x1b[2A\r' + report('5s'));
    await goQuiet();
    shadow.write('\x1b[2A\r' + report('7s'));
    await goQuiet();
    expect(emitted.filter((e) => e.type === 'report')).toHaveLength(1);
  });

  it('still supersedes a report that genuinely grows by a clean append (§15.3)', async () => {
    // Guard: the tail-mutation dedup must not swallow real growth. A clean word-boundary
    // append still retracts the partial and keeps the fuller capture.
    setupGeneric();
    shadow.write('the review found the auth flow sound and the migration well covered\r\n');
    await goQuiet();
    const first = emitted.filter((e) => e.type === 'report').length;
    shadow.write('and the test suite gives good coverage of the new edge cases too\r\n');
    await goQuiet();
    const texts = emitted.filter((e) => e.type === 'report').map((e) => e.text);
    expect(first).toBe(1);
    // The fuller capture is present (clean append preserved, not skipped as churn).
    expect(texts.some((t) => t.includes('edge cases'))).toBe(true);
  });

  it('merges a report streamed across a quiet pause into one capture, retracting the partial (§15.3 seal-on-witness)', async () => {
    // Seal-on-witness (§15.3 / v2.22): a bottom-most unit with no witness below it — no
    // following content and no turn-complete composer — is PROVISIONAL, not sealed. When the
    // stream resumes and that same buffer position grows, the partial is retracted and the
    // fuller capture replaces it: a report paused mid-stream is ONE capture, not two.
    emitted = [];
    const removed: string[] = [];
    let n = 0;
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        emitted.push(e);
        return String(++n);
      },
      remove: (id) => removed.push(id),
    });

    // Phase 1: a prose report streams partially, then the agent pauses (no composer below).
    shadow.write(
      'The authentication flow is sound and the migration path is well covered overall.\r\n' +
        'The error handling around the network layer could be tightened up in a few spots.\r\n',
    );
    await goQuiet();
    expect(emitted.filter((e) => e.type === 'report')).toHaveLength(1); // partial surfaced

    // Phase 2: the SAME report resumes (clean append at the same position) and completes.
    shadow.write(
      'The test suite gives good coverage of the new branches and the edge cases here.\r\n' +
        'FINAL CONCLUSION: approve the pull request once the network nits are addressed.\r\n',
    );
    await goQuiet();

    expect(removed).toContain('1'); // the partial is retracted, not left as a duplicate
    const merged = emitted.filter(
      (e) => e.type === 'report' && e.text.includes('authentication flow') && e.text.includes('FINAL CONCLUSION'),
    );
    expect(merged).toHaveLength(1); // head + continuation become a single capture
  });

  it('emits nothing on the alternate buffer (precise alt parsing is out of scope §15.9)', async () => {
    setupGeneric();
    shadow.write('\x1b[?1049h');
    await sleep(10);
    expect(() => shadow.write('- principal needs a fix\r\n- security needs a fix\r\n')).not.toThrow();
    await goQuiet();
    expect(emitted).toEqual([]);
  });

  it('drops a later capture that is a prefix-subset of one already captured (§15.3)', async () => {
    emitted = [];
    const removed: string[] = [];
    let regionText = '';
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const oneRegion: Adapter = {
      id: 'one-region',
      detect: () =>
        regionText ? [{ type: 'report', source: 'shadow-scan', text: regionText, startRow: 0, endRow: 0 }] : [],
    };
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [oneRegion],
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
      remove: (id) => removed.push(id),
    });

    regionText = 'The codebase review found the auth flow sound and the migration path well covered overall';
    shadow.write('a\r\n');
    await goQuiet();
    const after = emitted.length;

    regionText = 'The codebase review found the auth flow';
    shadow.write('b\r\n');
    await goQuiet();

    expect(emitted.length).toBe(after); // subset of an existing capture — not re-emitted
    expect(removed).toEqual([]); // and nothing already-captured is retracted
  });

  it('retracts the earlier partial when a later scan supersedes it at a word boundary (§15.3)', async () => {
    emitted = [];
    const removed: string[] = [];
    let regionText = '';
    let n = 0;
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const oneRegion: Adapter = {
      id: 'one-region',
      detect: () =>
        regionText ? [{ type: 'report', source: 'shadow-scan', text: regionText, startRow: 0, endRow: 0 }] : [],
    };
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [oneRegion],
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        emitted.push(e);
        return String(++n);
      },
      remove: (id) => removed.push(id),
    });

    const partial = 'The codebase review found the auth flow sound and the migration path well covered overall';
    regionText = partial;
    shadow.write('a\r\n');
    await goQuiet();
    expect(emitted.map((e) => e.text)).toEqual([partial]); // earlier partial, id "1"

    const full = partial + ' and the test suite gives good coverage of the new edge cases';
    regionText = full;
    shadow.write('b\r\n');
    await goQuiet();

    expect(emitted.some((e) => e.text === full)).toBe(true); // superseding report emitted
    expect(removed).toEqual(['1']); // earlier partial retracted so the pane drops it
  });

  it('skips a region the suppressor flags, still emitting the rest (§16.5 seam)', async () => {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [lineAdapter],
      dedupRetention: 200,
      reportMinChars: 120,
      isSuppressed: (region) => region.startRow === 0, // echoed-input row, per the watermark
      emit: collectingEmit,
    });
    shadow.write('Echoed input line?\r\nAgent reply line?\r\n');
    await goQuiet();
    expect(emitted.map((e) => e.text)).toEqual(['Agent reply line?']);
  });
});

describe('self-injection suppression end-to-end (§16.5 — real shadow + injector + suppressor)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let emitted: Parameters<ScannerEmit>[0][];
  let ptyWrites: string[];
  let inject: ReturnType<typeof createInjector>;

  const collectingEmit: ScannerEmit = (e) => {
    emitted.push(e);
    return String(emitted.length);
  };

  function setup(now: () => number = () => 1000, windowMs = 30000) {
    emitted = [];
    ptyWrites = [];
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const suppressor = createInjectionSuppressor({
      cursorRow: () => shadow.reader.cursor().y,
      addMarker: (r) => shadow.addMarker(r),
      now,
      windowMs,
    });
    inject = createInjector({
      write: (d) => ptyWrites.push(d),
      isBracketedPaste: () => shadow.isBracketedPaste(),
      submitDelayMs: 0,
      onInject: () => suppressor.noteInjection(),
    });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [lineAdapter],
      dedupRetention: 200,
      reportMinChars: 120,
      isSuppressed: (region) => suppressor.isSuppressed(region),
      emit: collectingEmit,
    });
  }

  afterEach(() => shadow?.dispose());

  it('does not re-emit the echoed injected input, but still emits the agent reply', async () => {
    setup();
    // The app injects a prompt; the inject path seeds the watermark at the
    // pre-echo cursor row (the injector writes to the PTY, not the shadow).
    inject('Should I refactor this?', { submit: true });
    // The session echoes the injected input, then the agent replies below it.
    shadow.write('Should I refactor this?\r\n');
    shadow.write('Yes, what about the tests?\r\n');
    await goQuiet();
    const texts = emitted.map((e) => e.text);
    expect(texts).not.toContain('Should I refactor this?');
    expect(texts).toContain('Yes, what about the tests?');
  });

  it('captures content at the watermark row once the suppression window has expired', async () => {
    let t = 1000;
    setup(() => t, 4000);
    inject('Should I refactor this?', { submit: false });
    t = 1000 + 5000; // window elapsed before the next quiet scan
    shadow.write('Should I refactor this?\r\n');
    await goQuiet();
    expect(emitted.map((e) => e.text)).toContain('Should I refactor this?');
  });
});
