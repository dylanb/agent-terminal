import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { extractText } from '../../src/main/extraction';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('extractText (§15.2 — wrapped-row reassembly + column slicing over ShadowReader)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  afterEach(() => shadow.dispose());

  function withShadow(cols: number, bytes: string) {
    shadow = createShadowModel({ cols, rows: 24, settleMs: 10, quietMs: 40, onStatus: () => {} });
    shadow.write(bytes);
    return sleep(60).then(() => shadow.reader);
  }

  it('rejoins wrapped rows into one logical line (no hard break at terminal width)', async () => {
    const reader = await withShadow(10, 'abcdefghijKLMNO');
    expect(extractText(reader, { startRow: 0, endRow: 1 })).toBe('abcdefghijKLMNO');
  });

  it('keeps unwrapped rows as separate logical lines', async () => {
    const reader = await withShadow(10, '1234567890ABC\r\nhello');
    expect(extractText(reader, { startRow: 0, endRow: 2 })).toBe('1234567890ABC\nhello');
  });

  it('slices the start column off the first row', async () => {
    const reader = await withShadow(80, 'hello world');
    expect(extractText(reader, { startRow: 0, endRow: 0, startCol: 6 })).toBe('world');
  });

  it('slices the end column off the last row', async () => {
    const reader = await withShadow(80, 'hello world');
    expect(extractText(reader, { startRow: 0, endRow: 0, startCol: 0, endCol: 5 })).toBe('hello');
  });

  it('applies both start and end columns on a single row', async () => {
    const reader = await withShadow(80, 'hello world');
    expect(extractText(reader, { startRow: 0, endRow: 0, startCol: 6, endCol: 11 })).toBe('world');
  });
});
