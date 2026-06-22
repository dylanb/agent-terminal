// Baseline capture (§15.3). Coupling with the scanner (§15.3 / v2.22): this relies on the window
// already opening at the stability frontier or a provisional run's own start, so it never walks up
// past startRow; the scanner's positional dedup merges a run re-gathered across a quiet pause.
// The alternate buffer emits nothing (precise alt is §15.9).

import type { Adapter, AdapterContext, DetectedRegion } from './types';
import type { CommandSpanRange } from '../spanTypes';
import { buildReportRegion } from '../findings';

type RowKind = 'prose' | 'blank' | 'boundary';

function insideClosedSpan(y: number, spans: CommandSpanRange[]): boolean {
  return spans.some((s) => y >= s.startRow && y <= s.endRow);
}

export function createGenericAdapter(): Adapter {
  return {
    id: 'baseline',
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, altScreen, closedSpans, reportMinChars, isChrome, isClaimed } = ctx;
      if (altScreen) return [];

      // Key on "has a word", not on any box glyph: a frame line must not split the prose drawn
      // inside a box, but its worded text lines must still capture. Glyph-agnostic by design (§15.x).
      const kind = (y: number): RowKind => {
        if (isChrome(y) || isClaimed?.(y) || insideClosedSpan(y, closedSpans)) return 'boundary';
        return /[\p{L}\p{N}]/u.test(reader.lineText(y)) ? 'prose' : 'blank';
      };

      const regions: DetectedRegion[] = [];
      let y = startRow;
      while (y <= endRow) {
        if (kind(y) !== 'prose') {
          y++;
          continue;
        }
        const start = y;
        let end = y;
        let scan = y;
        while (scan <= endRow && kind(scan) !== 'boundary') {
          if (kind(scan) === 'prose') end = scan;
          scan++;
        }
        // Separators render as empty so findings split on paragraph breaks (§15.6).
        const lines: string[] = [];
        for (let r = start; r <= end; r++) lines.push(kind(r) === 'prose' ? reader.lineText(r) : '');
        const text = lines.join('\n').trim();
        if (text.length >= reportMinChars) regions.push(buildReportRegion(text, 'heuristic', start, end));
        y = scan;
      }
      return regions;
    },
  };
}
