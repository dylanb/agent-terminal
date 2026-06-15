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

/**
 * One finding plus its **line span** within the report (0-based, inclusive). The span is
 * what lets a finding map back to its on-screen rows: the report text has one line per
 * buffer row (§15.3), so `startLine`/`endLine` are row offsets from the report's startRow,
 * the link the cross-highlight needs (§16.8).
 */
export interface Finding {
  text: string;
  startLine: number;
  endLine: number;
}

export function splitFindings(report: string): Finding[] {
  const lines = report.split('\n');
  const findings: Finding[] = [];
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
    // The inner loop stops at the first blank/boundary, so lines[start..i-1] are all
    // content — i-1 is the segment's last row.
    if (seg.trim() !== '') findings.push({ text: seg, startLine: start, endLine: i - 1 });
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
  // Each finding's line span offsets from the report's startRow: the report text has one
  // line per buffer row, so a chunk maps straight to its terminal rows for cross-highlight.
  const children =
    findings.length >= 2
      ? findings.map((f) => ({
          type: 'finding' as const,
          source,
          text: f.text,
          startRow: startRow + f.startLine,
          endRow: startRow + f.endLine,
        }))
      : [];
  return { type: 'report', source, text, startRow, endRow, children };
}
