// Claude Code adapter (§15.3 / v2.6). Deterministic line patterns on the normal
// (scrolling-transcript) buffer. Recognizes ⏺/⎿ tool-use blocks, ± diffs, and
// ⏺ prose reports (split into findings). Box-drawn prompts (permission/input) are
// chrome — scanned past, never emitted (permission/question detection removed in
// v2.6). Assertions in tests are on emitted events, so the exact patterns here can
// change as long as the detected event types/text are stable.

import type { Adapter, AdapterContext, DetectedRegion } from './types';
import type { ShadowReader } from '../shadow';
import { buildReportRegion } from '../findings';

const TOP_BORDER = /^[╭┌]/;
const BOTTOM_BORDER = /^[╰└]/;
const BULLET = '⏺';
const DIFF_LINE = /^[+-]\s/;
// A tool invocation head looks like `Name(args)`; a report head is prose.
const TOOL_CALL = /^[A-Za-z][\w.]*\(/;

const INDENTED = /^\s+\S/;

function stripBullet(line: string): string {
  return line.replace(/^⏺\s*/, '').trim();
}

/**
 * A prose report streams over several quiet scans (§8.3); a later scan's window can
 * open below the report's ⏺ — once it has scrolled above the viewport fold — leaving
 * the tail as a headless, flush-left continuation that would otherwise go uncaptured.
 * Walk up from the window start over flush-left prose to the originating prose bullet
 * and start there, so the whole report is re-gathered (content-dedup drops the no-ops).
 * Stop the walk at any chrome/tool boundary (box border, indented tool/diff line) or a
 * tool-call bullet — those mean the window is not a prose continuation.
 */
function anchorReportStart(reader: ShadowReader, startRow: number, endRow: number): number {
  if (startRow <= 0) return startRow;
  let first = startRow;
  while (first <= endRow && reader.lineText(first).trim() === '') first++;
  if (first > endRow) return startRow;
  const head = reader.lineText(first);
  const headTrim = head.trim();
  if (headTrim.startsWith(BULLET) || TOP_BORDER.test(headTrim) || BOTTOM_BORDER.test(headTrim) || INDENTED.test(head)) {
    return startRow; // window already opens on a bullet/box/indented block — not a continuation
  }
  for (let u = startRow - 1; u >= 0; u--) {
    const line = reader.lineText(u);
    const t = line.trim();
    if (t === '') continue;
    if (t.startsWith(BULLET)) return TOOL_CALL.test(stripBullet(t)) ? startRow : u;
    if (TOP_BORDER.test(t) || BOTTOM_BORDER.test(t) || INDENTED.test(line)) return startRow;
  }
  return startRow;
}

export function createClaudeCodeAdapter(): Adapter {
  return {
    id: 'claude-code',
    matches({ reader, startRow, endRow, isChrome }) {
      for (let y = startRow; y <= endRow; y++) {
        const t = reader.lineText(y);
        // ⏺ content or any recognized chrome (composer/status/echo) means this is a
        // Claude buffer — claim it so the greedy generic fallback never sees the chrome.
        if (t.includes(BULLET) || TOP_BORDER.test(t.trim()) || /esc to interrupt/i.test(t) || isChrome(y)) return true;
      }
      return false;
    },
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, reportMinChars, isChrome } = ctx;
      const regions: DetectedRegion[] = [];

      for (let y = anchorReportStart(reader, startRow, endRow); y <= endRow; ) {
        // Composer / status / echo furniture — skip the row, emit nothing (§15.x).
        if (isChrome(y)) {
          y++;
          continue;
        }
        const trimmed = reader.lineText(y).trim();

        // Boxes (permission prompt, input box) are chrome — skip past, emit nothing.
        if (TOP_BORDER.test(trimmed)) {
          let j = y + 1;
          while (j <= endRow && !BOTTOM_BORDER.test(reader.lineText(j).trim())) j++;
          y = j + 1;
          continue;
        }

        if (trimmed.startsWith(BULLET)) {
          const head = stripBullet(trimmed);
          // Tool-use / diff blocks have indented (⎿ / further-indented) continuations.
          let j = y + 1;
          while (j <= endRow && /^\s+\S/.test(reader.lineText(j))) j++;
          const block: string[] = [];
          for (let k = y; k < j; k++) block.push(reader.lineText(k).trim());
          const continuations = block.slice(1).map((l) => l.replace(/^⎿\s*/, '').trim());

          if (continuations.some((l) => DIFF_LINE.test(l))) {
            regions.push({ type: 'diff', source: 'shadow-scan', text: block.join('\n'), startRow: y, endRow: j - 1 });
            y = j;
            continue;
          }
          if (TOOL_CALL.test(head)) {
            regions.push({ type: 'tool-use', source: 'shadow-scan', text: block.join('\n'), startRow: y, endRow: j - 1 });
            y = j;
            continue;
          }

          // Prose report: gather flush-left body until the next bullet, box, chrome, or end.
          let k = y + 1;
          while (k <= endRow) {
            const t = reader.lineText(k).trim();
            if (t.startsWith(BULLET) || TOP_BORDER.test(t) || isChrome(k)) break;
            k++;
          }
          const lines = [head];
          for (let r = y + 1; r < k; r++) lines.push(reader.lineText(r));
          const text = lines.join('\n').trim();
          const start = y;
          y = k;
          if (text.length >= reportMinChars) regions.push(buildReportRegion(text, 'shadow-scan', start, k - 1));
          continue;
        }

        y++;
      }

      return regions;
    },
  };
}
