// Claude Code adapter (§15.3 / v2.6). Deterministic line patterns on the normal
// (scrolling-transcript) buffer. Recognizes ⏺/⎿ tool-use blocks, ± diffs, and
// ⏺ prose reports (split into findings). Box-drawn prompts (permission/input) are
// chrome — scanned past, never emitted (permission/question detection removed in
// v2.6). Assertions in tests are on emitted events, so the exact patterns here can
// change as long as the detected event types/text are stable.

import type { Adapter, AdapterContext, DetectedRegion } from './types';
import { buildReportRegion } from '../findings';

const TOP_BORDER = /^[╭┌]/;
const BOTTOM_BORDER = /^[╰└]/;
const BULLET = '⏺';
const DIFF_LINE = /^[+-]\s/;
// A tool invocation head looks like `Name(args)`; a report head is prose.
const TOOL_CALL = /^[A-Za-z][\w.]*\(/;

function stripBullet(line: string): string {
  return line.replace(/^⏺\s*/, '').trim();
}

export function createClaudeCodeAdapter(): Adapter {
  return {
    id: 'claude-code',
    matches({ reader, startRow, endRow }) {
      for (let y = startRow; y <= endRow; y++) {
        const t = reader.lineText(y);
        if (t.includes(BULLET) || TOP_BORDER.test(t.trim()) || /esc to interrupt/i.test(t)) return true;
      }
      return false;
    },
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, reportMinChars } = ctx;
      const regions: DetectedRegion[] = [];

      for (let y = startRow; y <= endRow; ) {
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

          // Prose report: gather flush-left body until the next bullet, box, or end.
          let k = y + 1;
          while (k <= endRow) {
            const t = reader.lineText(k).trim();
            if (t.startsWith(BULLET) || TOP_BORDER.test(t)) break;
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
