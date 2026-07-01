import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmit } from '../../src/main/scanner';
import { createInjector } from '../../src/main/inject';
import { createInjectionSuppressor } from '../../src/main/injectionSuppression';
import { createGenericAdapter } from '../../src/main/adapters/generic';
import { createClaudeCodeAdapter } from '../../src/main/adapters/claudeCode';
import type { Adapter } from '../../src/main/adapters/types';
import type { CommandSpanRange } from '../../src/main/spanTypes';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous margins: vitest's parallel workers can delay setTimeout-based quiet transitions
// well past quietMs under CPU contention.
const SETTLE = 10;
const QUIET = 40;
const goQuiet = () => sleep(220);

// Config injection, NOT an emulator mock (§15.8).
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
    expect(emitted.length).toBe(0);
    await goQuiet();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toMatchObject({ type: 'report', text: 'Do you want to continue?', parentId: null });
  });

  it('stamps a top-level emission with its on-screen rows so the pane can cross-highlight (§15.4)', async () => {
    setup();
    shadow.write('Do you want to continue?\r\n');
    await goQuiet();
    expect(emitted.length).toBe(1);
    expect(emitted[0].range).toMatchObject({
      start: { y: 0 },
      end: { y: 0 },
      baseY: 0,
      bufferType: 'normal',
    });
  });

  it('stamps each finding with its own on-screen rows so a chunk highlights alone (§16.8)', async () => {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 40,
      emit: collectingEmit,
    });

    shadow.write(
      '- alpha finding worth acting on that is long enough to count\r\n' +
        '- beta finding to address before merge that is also long enough\r\n',
    );
    await goQuiet();

    const report = emitted.find((e) => e.type === 'report')!;
    const findings = emitted.filter((e) => e.type === 'finding');
    expect(report.range).toMatchObject({ start: { y: 0 }, end: { y: 1 } });
    expect(findings.length).toBe(2);
    expect(findings[0]).toMatchObject({ text: expect.stringContaining('alpha'), range: { start: { y: 0 }, end: { y: 0 } } });
    expect(findings[1]).toMatchObject({ text: expect.stringContaining('beta'), range: { start: { y: 1 }, end: { y: 1 } } });
  });

  it('consults the live chrome-marker profile so a newly-learned glyph filters future furniture (§15.x)', async () => {
    // Acceptance for "mark as chrome": once a custom glyph is learned, lines led by it stop being captured.
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

    shadow.write(
      '◆ the custom themed status glyph shows progress and elapsed time as it works\r\n' +
        '◆ and a second custom-glyph line keeps the running token and context in view\r\n',
    );
    await goQuiet();
    expect(emitted.length).toBe(1);
    expect(emitted[0].text).toContain('custom themed status glyph');

    markers.push('◆'); // user marks ◆ as chrome

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
      adapters: [], // generic fallback only (§15.3)
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars,
      closedSpans: () => closed,
      emit: collectingEmit,
    });
  }

  function setupClaude(reportMinChars = 80) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [createClaudeCodeAdapter()],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars,
      closedSpans: () => [],
      emit: collectingEmit,
    });
  }

  it("claims ●-bulleted tool calls (not only ⏺) so tool output is carved out, not folded into the report (§15.x)", async () => {
    // Regression: the classifier hard-coded ⏺ (U+23FA), so Claude Code's ● (U+25CF) tool bullets
    // went dark and folded into the prose report. Capture must be bullet-glyph-agnostic.
    setupClaude();
    shadow.write(
      '● Bash(echo distinctive-tool-noise)\r\n' +
        '  ⎿  distinctive-tool-noise\r\n' +
        '\r\n' +
        '● Here is the actual written analysis that should stand alone as the report, with ' +
        'enough prose to clear the minimum and leave the tool noise above it behind.\r\n',
    );
    await goQuiet();
    const reports = emitted.filter((e) => e.type === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('actual written analysis');
    expect(reports[0].text).not.toContain('distinctive-tool-noise');
    expect(emitted.some((e) => e.type === 'tool-use')).toBe(true);
  });

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
    expect(findings.every((f) => f.parentId === String(1))).toBe(true);
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
    shadow.write('\r\n');
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
    shadow.write('\x1b[1A\r' + tail('20pct'));
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

    // Phase 1: a prose report streams partially, then pauses (no composer below → no witness).
    shadow.write(
      'The authentication flow is sound and the migration path is well covered overall.\r\n' +
        'The error handling around the network layer could be tightened up in a few spots.\r\n',
    );
    await goQuiet();
    expect(emitted.filter((e) => e.type === 'report')).toHaveLength(1);

    // Phase 2: the same report resumes (clean append at the same position).
    shadow.write(
      'The test suite gives good coverage of the new branches and the edge cases here.\r\n' +
        'FINAL CONCLUSION: approve the pull request once the network nits are addressed.\r\n',
    );
    await goQuiet();

    expect(removed).toContain('1'); // partial retracted, not left as a duplicate
    const merged = emitted.filter(
      (e) => e.type === 'report' && e.text.includes('authentication flow') && e.text.includes('FINAL CONCLUSION'),
    );
    expect(merged).toHaveLength(1);
  });

  it('merges a report TALLER than the viewport streamed across a pause into one capture (§15.3 — scrollback is not a seal)', async () => {
    // Regression: a report that outgrows the viewport has its head scroll into scrollback.
    // The bottom-most unit is still PROVISIONAL — the scrolled-off rows are immutable but the
    // run must be re-gathered from its true start to merge. If the frontier is force-advanced
    // to the viewport top (baseY) each scan, every screenful is sealed and re-emitted as a
    // fresh report, splitting one logical report into many — the live capture bug.
    emitted = [];
    const removed: string[] = [];
    let n = 0;
    shadow = createShadowModel({ cols: 80, rows: 6, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
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

    // Phase 1: prose streams past the 6-row viewport, so its head scrolls into scrollback.
    shadow.write(
      'AUTHFLOW the authentication flow is sound across every reviewed module.\r\n' +
        'The migration path is well covered by the integration suite overall.\r\n' +
        'The error handling around the network layer needs tightening in spots.\r\n' +
        'The retry policy looks consistent with the documented backoff strategy.\r\n' +
        'Logging is structured and avoids leaking any secrets into the output.\r\n' +
        'Configuration parsing rejects unknown keys with a clear actionable error.\r\n' +
        'The cache invalidation path is exercised by two separate scenarios here.\r\n' +
        'Connection pooling reuses sockets and closes them on idle as expected.\r\n',
    );
    await goQuiet();

    // Phase 2: the same report resumes (clean append) and completes.
    shadow.write(
      'The test suite gives good coverage of the new branches and edge cases.\r\n' +
        'Documentation was updated to match the new public API surface exactly.\r\n' +
        'FINALVERDICT approve the pull request once the network nits are handled.\r\n',
    );
    await goQuiet();

    const merged = emitted.filter(
      (e) => e.type === 'report' && e.text.includes('AUTHFLOW') && e.text.includes('FINALVERDICT'),
    );
    expect(merged).toHaveLength(1); // scrollback head + tail are ONE capture, not screen-by-screen splits
    expect(removed).toContain('1');
  });

  it('merges a report streamed with the input composer pinned below it, not one chunk per pause (§15.3 / v2.25)', async () => {
    // Claude Code keeps its rule-framed composer (────/❯/────/strip) pinned at the viewport
    // bottom WHILE STREAMING (the strip reads "esc to interrupt"). A composer below the output
    // is therefore NOT proof the turn is done — the bottom unit can still grow. Sealing up to
    // that composer each quiet pause shredded one streamed report into a chunk per pause (the
    // live capture bug). The bottom-most unit must stay provisional even with a composer below.
    emitted = [];
    const removed: string[] = [];
    const seen: { id: string; type: string; text: string }[] = [];
    let n = 0;
    shadow = createShadowModel({ cols: 80, rows: 10, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 80,
      emit: (e) => {
        const id = String(++n);
        seen.push({ id, type: e.type, text: e.text });
        return id;
      },
      remove: (id) => removed.push(id),
    });

    const RULE = '─'.repeat(78);
    const composer = ['', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab) · esc to interrupt'];
    const bursts = [
      ['REPORTHEAD the authentication flow is sound across the reviewed modules.', 'The migration path is well covered by the integration suite overall now.'],
      ['The error handling around the network layer needs tightening in a spot.', 'The retry policy is consistent with the documented backoff strategy here.'],
      ['Logging is structured and avoids leaking any secrets into the output now.', 'REPORTTAIL approve the pull request once the network nits are addressed.'],
    ];
    for (let i = 0; i < bursts.length; i++) {
      // Mirror the agent: erase the prior composer, stream more, redraw it pinned below — so a
      // composer is present at every quiet pause.
      if (i > 0) shadow.write('\x1b[4A\r\x1b[J');
      shadow.write(bursts[i].map((l) => l + '\r\n').join(''));
      shadow.write(composer.join('\r\n'));
      await goQuiet();
    }

    const live = seen.filter((r) => r.type === 'report' && !removed.includes(r.id));
    const whole = live.filter((r) => r.text.includes('REPORTHEAD') && r.text.includes('REPORTTAIL'));
    expect(whole).toHaveLength(1); // one capture spanning head..tail, not shredded per pause
    expect(live).toHaveLength(1);
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
    expect(removed).toEqual([]);
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
    expect(emitted.map((e) => e.text)).toEqual([partial]); // emitted as id "1"

    const full = partial + ' and the test suite gives good coverage of the new edge cases';
    regionText = full;
    shadow.write('b\r\n');
    await goQuiet();

    expect(emitted.some((e) => e.text === full)).toBe(true);
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
    inject('Should I refactor this?', { submit: true });
    shadow.write('Should I refactor this?\r\n'); // session echoes the injected input
    shadow.write('Yes, what about the tests?\r\n'); // agent reply below it
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

// §21.1 / v2.27: the app retired auto-emit-on-quiet — a "Capture last report" button drives
// captureLast() on demand. The scanner only subscribes to onQuiet when one is supplied (tests
// still do, above), so these dormant scanners prove the button path alone.
describe('manual capture on demand (§21.1 — captureLast, dormant auto-scan)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let emitted: Parameters<ScannerEmit>[0][];

  const collectingEmit: ScannerEmit = (e) => {
    emitted.push(e);
    return String(emitted.length);
  };

  afterEach(() => shadow?.dispose());

  /** A scanner with NO onQuiet (dormant) — the app's wiring; captureLast is the only path. */
  function dormant(adapters: Adapter[], baseline?: Adapter, reportMinChars = 40) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    return createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      adapters,
      baseline,
      dedupRetention: 200,
      reportMinChars,
      emit: collectingEmit,
    });
  }

  it('returns the LATEST report (bottom-most region) on demand, with its on-screen range', async () => {
    const scanner = dormant([lineAdapter]);
    shadow.write('Is the first question ok?\r\nShould the second one win?\r\n');
    await sleep(50); // flush the parser; no quiet trigger drives capture here
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.type).toBe('report');
    expect(result!.report.text).toBe('Should the second one win?');
    expect(result!.report.range).toMatchObject({ start: { y: 1 }, end: { y: 1 }, baseY: 0 });
  });

  it('splits the captured report into findings, each with its own range (§15.7/§16.8)', async () => {
    const scanner = dormant([], createGenericAdapter());
    shadow.write(
      '- alpha finding worth acting on that is long enough to count\r\n' +
        '- beta finding to address before merge that is also long enough\r\n',
    );
    await sleep(50);
    const result = scanner.captureLast()!;
    expect(result.report.range).toMatchObject({ start: { y: 0 }, end: { y: 1 } });
    expect(result.findings.map((f) => f.text)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
    expect(result.findings[0].range).toMatchObject({ start: { y: 0 }, end: { y: 0 } });
    expect(result.findings[1].range).toMatchObject({ start: { y: 1 }, end: { y: 1 } });
  });

  it('returns null when there is no report to capture', async () => {
    const scanner = dormant([], createGenericAdapter(), 500);
    shadow.write('ok done\r\n');
    await sleep(50);
    expect(scanner.captureLast()).toBeNull();
  });

  it('never auto-emits on a quiet transition (dormant — no onQuiet wired)', async () => {
    const scanner = dormant([lineAdapter]);
    shadow.write('Do you want to continue?\r\n');
    await goQuiet();
    expect(emitted.length).toBe(0);
    expect(scanner.captureLast()).not.toBeNull();
  });

  it('skips a candidate report that is just the echoed command line (§21.1)', async () => {
    // The only report candidate left (output gated by a closed span) is the echoed command-input
    // line — the user's own input, not a report — so capture must surface nothing.
    emitted = [];
    const cmd = "printf '%s' " + 'X'.repeat(140); // >reportMinChars so the baseline would capture it
    shadow = createShadowModel({ cols: 200, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const scanner = createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
      commandTexts: () => [cmd],
    });
    shadow.write('user@host:~$ ' + cmd + '\r\n');
    await sleep(50);
    expect(scanner.captureLast()).toBeNull();
  });

  it('keeps a report that merely MENTIONS a tracked command mid-text (not an echo, §21.1)', async () => {
    // The echo filter must match the command at the END of the echoed input line, not anywhere:
    // a real report that names a command inside its prose ("…run npm test…") is not an echo.
    emitted = [];
    const report =
      'FINAL CONCLUSION: you should run npm test to verify the authentication flow before merging, then revisit the remaining edge cases noted above.';
    shadow = createShadowModel({ cols: 200, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const scanner = createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
      commandTexts: () => ['npm test'],
    });
    shadow.write(report + '\r\n');
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('FINAL CONCLUSION');
  });

  it('captures the visible report on the ALTERNATE buffer (full-screen agent, §21.1/§13.4)', async () => {
    // Claude Code 2.x runs full-screen on the alt buffer. On-demand capture must read the
    // visible frame there too — the auto-scan path stays off (it has no onQuiet here).
    const scanner = dormant([], createGenericAdapter());
    shadow.write('\x1b[?1049h'); // enter the alternate screen buffer
    await sleep(10);
    shadow.write(
      '- alpha finding worth acting on that is long enough to count\r\n' +
        '- beta finding to address before merge that is also long enough\r\n',
    );
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.range!.bufferType).toBe('alternate');
    expect(result!.findings.map((f) => f.text)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
  });

  it('skips a Claude Code "※ recap:" line and captures the real report above it (§21.1)', async () => {
    // Claude Code prints a one-line "※ recap:" turn summary (toggled by /config) below the real
    // output — it is the agent's meta-recap, not the latest report, so capture must take the
    // substantive report above it, not the bottom-most recap line.
    const scanner = dormant([createClaudeCodeAdapter()], createGenericAdapter());
    shadow.write(
      'FINAL CONCLUSION: the auth flow is solid and well covered before merge.\r\n' +
        '⏺ Bash(npm test)\r\n' +
        '※ recap: tightened the deny list and pinned the branch before merge.\r\n',
    );
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('FINAL CONCLUSION');
    expect(result!.report.text).not.toContain('recap');
  });

  it('skips a "※ recap:" region whose first row is indented (§21.1)', async () => {
    // A region's first-line indent is stripped when its text is built, so the start-anchored
    // /^※/ still matches — the adapter's meta-summary predicate needs no whitespace normalization.
    // (Skip the filter and this indented recap wins selection instead of being dropped.)
    const scanner = dormant([createClaudeCodeAdapter()], createGenericAdapter());
    shadow.write('    ※ recap: tightened the deny list and pinned the branch before you merge this.\r\n');
    await sleep(50);
    expect(scanner.captureLast()).toBeNull();
  });

  it('returns null when the only report candidate is a "※ recap:" line (§21.1)', async () => {
    const scanner = dormant([createClaudeCodeAdapter()], createGenericAdapter());
    shadow.write('※ recap: analyzed the PR and tightened the deny list before merge.\r\n');
    await sleep(50);
    expect(scanner.captureLast()).toBeNull();
  });

  it('captures a "※ recap:" region as a report when no Claude Code adapter is active (§21.1/§15.3)', async () => {
    // Per-agent marker knowledge lives in the agent's classifier, not the agnostic scanner core
    // (§15.3): with no Claude adapter wired, nothing recognizes "※ recap:" as a meta-summary, so
    // the line is an ordinary report and wins selection.
    const scanner = dormant([], createGenericAdapter());
    shadow.write('※ recap: analyzed the PR and tightened the deny list before merge.\r\n');
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('recap');
  });

  it('keeps a report whose first line is "recap:" but lacks the ※ mark (§21.1)', async () => {
    // The skip is for Claude Code's "※ recap:" marker specifically, not any line starting "recap:":
    // a real report that opens with the word "recap:" is the user's own prose and must be captured.
    const scanner = dormant([], createGenericAdapter());
    shadow.write('recap: my own prose summary of the work before you merge this branch to main.\r\n');
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('my own prose summary');
  });

  it('keeps a report that merely MENTIONS recap mid-text (not a recap line, §21.1)', async () => {
    // The recap filter must anchor on the "※ recap:" prefix, not the word anywhere: a real report
    // that names "recap" inside its prose is not a recap line.
    const scanner = dormant([], createGenericAdapter());
    shadow.write('FINAL CONCLUSION: write a recap of the findings before you merge this branch.\r\n');
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('FINAL CONCLUSION');
  });

  it('keeps a prose report that ENDS with a command phrase (not a prompt+command echo, §21.1)', async () => {
    // The echo is "<prompt> <command>" — only a prompt may precede the command. A report whose prose
    // happens to end with the command (no prompt before it) must NOT be dropped.
    emitted = [];
    const report =
      'FINAL CONCLUSION: the authentication flow looks solid and is well covered; before you merge this branch you should then run npm test';
    shadow = createShadowModel({ cols: 200, rows: 24, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    const scanner = createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      adapters: [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: collectingEmit,
      commandTexts: () => ['npm test'],
    });
    shadow.write(report + '\r\n');
    await sleep(50);
    const result = scanner.captureLast();
    expect(result).not.toBeNull();
    expect(result!.report.text).toContain('FINAL CONCLUSION');
  });
});
