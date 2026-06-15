// Baseline capture (§15.3). The glyph-agnostic heart of the pipeline: at a quiet
// transition it captures contiguous runs of substantial **new prose** as reports,
// keying on nothing agent-specific. A row counts as prose unless it is chrome
// (composer/status/box — §15.x), inside a finished command's output span (§15.6), or
// claimed by a classifier as a structured block (tool-use/diff). Boundaries split runs
// into separate reports; blank lines are kept as paragraph separators. The scanner opens
// the window past its stability frontier (§15.3 / v2.22): sealed rows are gone, but the
// bottom-most provisional run still opens at its own start, so a run that streamed across a
// quiet pause is re-gathered whole here and merged by the scanner's positional dedup.
// Stateless: no remembered line set. The alternate buffer emits nothing (precise alt is §15.9).

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

      // A wordless line (blank, or a pure frame/rule/separator like ╭──╮ / ──── / ├──┤)
      // is a paragraph separator, not prose and not a boundary — so a box's frame never
      // splits or pollutes the report summary Claude drew inside it, but its text lines
      // (which carry words) are captured. Keys on "has a word", not on any box glyph.
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
        // A run's real start is never above startRow: the scanner's window already opens at
        // the stability frontier (sealed rows excluded) or at a still-provisional run's own
        // start (§15.3 / v2.22) — no walk-up needed. Extend down to the run's end (the last
        // prose row before a boundary).
        const start = y;
        let end = y;
        let scan = y;
        while (scan <= endRow && kind(scan) !== 'boundary') {
          if (kind(scan) === 'prose') end = scan;
          scan++;
        }
        // Keep prose lines verbatim; render separators (blanks/frames) as empty so the
        // captured text reads as paragraphs and findings split cleanly (§15.6).
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
