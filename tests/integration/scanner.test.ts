import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmit } from '../../src/main/scanner';
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
// every line ending in '?' within the scan window is an agent-question.
const questionAdapter: Adapter = {
  id: 'test-question',
  detect: ({ reader, startRow, endRow }) => {
    const out = [];
    for (let y = startRow; y <= endRow; y++) {
      const t = reader.lineText(y).trim();
      if (t.endsWith('?')) {
        out.push({ type: 'agent-question' as const, source: 'shadow-scan' as const, text: t, startRow: y, endRow: y });
      }
    }
    return out;
  },
};

describe('semantic scanner (§15.2/§15.3 — quiet-triggered, watermarked, deduped)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let emitted: Parameters<ScannerEmit>[0][];

  function setup(scrollback = 5000, rows = 24) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows, scrollback, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [questionAdapter],
      dedupRetention: 200,
      emit: (e) => emitted.push(e),
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
    expect(emitted[0]).toMatchObject({ type: 'agent-question', text: 'Do you want to continue?' });
  });

  it('dedups an unchanged region across repeated quiet transitions', async () => {
    setup();
    shadow.write('Continue?\r\n');
    await goQuiet();
    expect(emitted.length).toBe(1);
    shadow.write('\r\n'); // new activity, but the question region is unchanged
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

  function setupGeneric(closed: CommandSpanRange[] = []) {
    emitted = [];
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: SETTLE, quietMs: QUIET, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [], // no specific adapter matches → degrade to the generic fallback (§15.3)
      fallback: createGenericAdapter(),
      dedupRetention: 200,
      closedSpans: () => closed,
      emit: (e) => emitted.push(e),
    });
  }

  it('degrades to the generic fallback and labels its emissions heuristic', async () => {
    setupGeneric();
    shadow.write('Do you want to proceed?\r\nAre you sure?\r\n');
    await goQuiet();
    const text = (t: string) => emitted.filter((e) => e.type === t).map((e) => e.text);
    expect(text('permission-prompt')).toContain('Do you want to proceed?'); // strong prompt
    expect(text('agent-question')).toContain('Are you sure?'); // bare trailing ?
    expect(emitted.every((e) => e.source === 'heuristic')).toBe(true);
  });

  it('suppresses an unchanged prompt-like line on re-scan but emits a newly-changed one', async () => {
    setupGeneric();
    shadow.write('Are you sure?\r\n');
    await goQuiet();
    expect(emitted.map((e) => e.text)).toEqual(['Are you sure?']);
    shadow.write('All done now?\r\n'); // prior line stable (chrome), a new prompt-like line appears
    await goQuiet();
    expect(emitted.map((e) => e.text)).toEqual(['Are you sure?', 'All done now?']);
  });

  it('skips a prompt-like line that falls inside a closed command-output span (§15.6)', async () => {
    setupGeneric([{ startRow: 0, endRow: 5 }]); // the prompt text lands on row 0 = command output
    shadow.write('Are you sure?\r\n');
    await goQuiet();
    expect(emitted).toEqual([]);
  });

  it('runs on the alternate buffer without crashing and dedups identical screens', async () => {
    setup();
    shadow.write('\x1b[?1049h');
    await sleep(10);
    expect(() => shadow.write('Alt prompt?\r\n')).not.toThrow();
    await goQuiet();
    const first = emitted.length;
    expect(first).toBeGreaterThanOrEqual(1);
    shadow.write('\r\n');
    await goQuiet();
    expect(emitted.length).toBe(first); // same region deduped, no crash
  });
});
