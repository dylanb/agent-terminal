// Generic fallback heuristic (§15.3 / v2.6). Used only when no specific adapter
// matches. Permission/question detection was removed in v2.6 (it false-positived
// on report prose and code/diff lines in scrollback). Instead: a substantial block
// of *new* content at a quiet transition is surfaced as a `report` and split into
// findings. Stable rows across scans are chrome and skipped; output rows inside
// closed OSC-133 command spans are skipped (they're command output, not a report).
// The alternate buffer emits nothing this phase (precise alt parsing is §15.9).

import type { Adapter, AdapterContext, DetectedRegion } from './types';
import type { CommandSpanRange } from '../spanTypes';
import { buildReportRegion } from '../findings';

function insideClosedSpan(y: number, spans: CommandSpanRange[]): boolean {
  return spans.some((s) => y >= s.startRow && y <= s.endRow);
}

export function createGenericAdapter(): Adapter {
  let prevLines = new Set<string>();

  return {
    id: 'generic',
    matches: () => false, // fallback-only; never selected as a specific adapter
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, altScreen, closedSpans, reportMinChars, isChrome } = ctx;
      const curLines = new Set<string>();
      for (let y = startRow; y <= endRow; y++) curLines.add(reader.lineText(y).trim());

      if (altScreen) {
        prevLines = curLines;
        return [];
      }

      const collected: string[] = [];
      for (let y = startRow; y <= endRow; y++) {
        const raw = reader.lineText(y);
        const t = raw.trim();
        if (!t) {
          collected.push(''); // preserve paragraph separators for finding-splitting
          continue;
        }
        if (insideClosedSpan(y, closedSpans)) continue;
        if (isChrome(y)) continue; // composer/status/echo furniture (§15.x)
        if (prevLines.has(t)) continue; // stable chrome
        collected.push(raw);
      }
      prevLines = curLines;

      const text = collected.join('\n').trim();
      if (text.length < reportMinChars) return [];
      return [buildReportRegion(text, 'heuristic', startRow, endRow)];
    },
  };
}
