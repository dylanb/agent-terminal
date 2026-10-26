// Report → findings splitter (§15.3). Operates on already-unwrapped logical lines —
// extraction.ts has joined wrapped rows, so one input line maps to one buffer row, which is
// what lets a finding's line span map back to its on-screen rows (§16.8 cross-highlight).

import type { MonitorEventSource } from '../shared/ipc';
import type { DetectedRegion } from './adapters/types';

const LIST = /^(\s*)(?:[-*•]|\d+[.)])\s+/;

function listIndent(line: string): number | null {
  const m = LIST.exec(line);
  return m ? m[1].length : null;
}

/** One finding plus its line span within the report (0-based, inclusive) — row offsets from the
 *  report's startRow, the link the §16.8 cross-highlight needs. */
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
      // A sibling/ancestor list item begins the next finding; deeper sub-bullets continue this one (§15.3).
      if (ind !== null && (baseIndent === null || ind <= baseIndent)) break;
      i++;
    }
    const seg = lines.slice(start, i).join('\n');
    if (seg.trim() !== '') findings.push({ text: seg, startLine: start, endLine: i - 1 });
  }
  return findings;
}

/**
 * A report region from already-extracted text. Findings become children only when there are ≥2:
 * a single-segment report stands alone, never duplicated as its own child (§15.6).
 */
export function buildReportRegion(
  text: string,
  source: MonitorEventSource,
  startRow: number,
  endRow: number,
): DetectedRegion {
  const findings = splitFindings(text);
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
