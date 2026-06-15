// Claude Code classifier (§15.3). Enrichment only: it recognizes the structured blocks
// Claude renders deterministically — `⏺ Name(args)` tool calls and `±` diffs — and
// emits them as typed `tool-use` / `diff` events. The scanner carves their rows out of
// the baseline so the same text isn't also captured as prose. It deliberately does NOT
// detect reports: report capture is the glyph-agnostic baseline's job, so a themed or
// version-changed bullet (⏺ vs ●) can never cost us a capture. Chrome rows are skipped
// (never classified). Assertions are on emitted events, so the patterns here can change
// as long as the detected types/text stay stable.

import type { Adapter, AdapterContext, DetectedRegion } from './types';

const BULLET = '⏺';
const DIFF_LINE = /^[+-]\s/;
// A tool invocation head looks like `Name(args)`; prose (a report) is left to the baseline.
const TOOL_CALL = /^[A-Za-z][\w.]*\(/;

function stripBullet(line: string): string {
  return line.replace(/^⏺\s*/, '').trim();
}

export function createClaudeCodeAdapter(): Adapter {
  return {
    id: 'claude-code',
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, isChrome } = ctx;
      const regions: DetectedRegion[] = [];

      for (let y = startRow; y <= endRow; ) {
        if (isChrome(y) || !reader.lineText(y).trim().startsWith(BULLET)) {
          y++;
          continue;
        }
        const head = stripBullet(reader.lineText(y).trim());
        // A tool-use / diff block carries indented (⎿ / further-indented) continuations.
        let j = y + 1;
        while (j <= endRow && /^\s+\S/.test(reader.lineText(j))) j++;
        const block: string[] = [];
        for (let k = y; k < j; k++) block.push(reader.lineText(k).trim());
        const continuations = block.slice(1).map((l) => l.replace(/^⎿\s*/, '').trim());

        if (continuations.some((l) => DIFF_LINE.test(l))) {
          regions.push({ type: 'diff', source: 'shadow-scan', text: block.join('\n'), startRow: y, endRow: j - 1 });
        } else if (TOOL_CALL.test(head)) {
          regions.push({ type: 'tool-use', source: 'shadow-scan', text: block.join('\n'), startRow: y, endRow: j - 1 });
        }
        // A prose `⏺` block (a report) is intentionally left for the baseline.
        y = j;
      }

      return regions;
    },
  };
}
