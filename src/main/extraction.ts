// Text extraction over the shadow's public read path (§15.2). Must rejoin wrapped rows
// the same way getSelection() does on the manual path, or the two paths diverge.

import type { ShadowReader } from './shadow';

export interface ExtractRange {
  startRow: number;
  /** Inclusive. */
  endRow: number;
  /** Column the region begins at on startRow (default 0). */
  startCol?: number;
  /** Exclusive column the region ends at on endRow (default: end of row). */
  endCol?: number;
}

export function extractText(reader: ShadowReader, range: ExtractRange): string {
  const { startRow, endRow } = range;
  const startCol = range.startCol ?? 0;
  const { endCol } = range;
  const logical: string[] = [];

  for (let y = startRow; y <= endRow; y++) {
    const nextWraps = y < endRow && reader.isLineWrapped(y + 1);
    let text = reader.lineText(y, !nextWraps);
    if (y === endRow && endCol !== undefined) text = text.slice(0, endCol);
    if (y === startRow && startCol > 0) text = text.slice(startCol);

    if (y > startRow && reader.isLineWrapped(y)) {
      logical[logical.length - 1] += text;
    } else {
      logical.push(text);
    }
  }

  return logical.join('\n');
}
