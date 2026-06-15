// Report → findings splitter (§15.3). A captured agent report is broken into
// individually-actionable findings: each top-level list item is one finding, and
// each non-list paragraph (blank-line delimited) is one finding. Sub-bullets and
// wrapped continuations stay with their parent item. Pure function — operates on
// the report's already-unwrapped logical lines (extraction.ts joins wrapped rows).
//
// MVP boundary: a blank line ends the current finding; a list marker whose indent
// is <= the item's own indent starts the next finding.

import type { MonitorEventSource } from '../shared/ipc';
import type { DetectedRegion } from './adapters/types';

const LIST = /^(\s*)(?:[-*•]|\d+[.)])\s+/;

/** Leading-space count if the line is a list-item marker, else null. */
function listIndent(line: string): number | null {
  const m = LIST.exec(line);
  return m ? m[1].length : null;
}

export function splitFindings(report: string): string[] {
  const lines = report.split('\n');
  const findings: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const start = i;
    const baseIndent = listIndent(lines[i]);
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      const ind = listIndent(lines[i]);
      // A sibling/ancestor list item (or any list item after a paragraph start)
      // begins the next finding; deeper sub-bullets are continuations.
      if (ind !== null && (baseIndent === null || ind <= baseIndent)) break;
      i++;
    }
    const seg = lines.slice(start, i).join('\n');
    if (seg.trim() !== '') findings.push(seg);
  }
  return findings;
}

/**
 * Build a report region from already-extracted text. Findings are emitted as
 * children only when there are ≥2 — a single-segment report stands alone, so the
 * pane never shows a finding identical to its parent (§15.6 / v2.6).
 */
export function buildReportRegion(
  text: string,
  source: MonitorEventSource,
  startRow: number,
  endRow: number,
): DetectedRegion {
  const findings = splitFindings(text);
  const children = findings.length >= 2 ? findings.map((f) => ({ type: 'finding' as const, source, text: f })) : [];
  return { type: 'report', source, text, startRow, endRow, children };
}
