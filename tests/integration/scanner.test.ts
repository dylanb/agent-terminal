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
      fallback: createGenericAdapter(),
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

  it('emits nothing on the alternate buffer (precise alt parsing is out of scope §15.9)', async () => {
    setupGeneric();
    shadow.write('\x1b[?1049h');
    await sleep(10);
    expect(() => shadow.write('- principal needs a fix\r\n- security needs a fix\r\n')).not.toThrow();
    await goQuiet();
    expect(emitted).toEqual([]);
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
