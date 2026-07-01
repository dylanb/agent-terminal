// Claude Code classifier (§15.3). Enrichment only — it deliberately does NOT detect reports: that
// is the glyph-agnostic baseline's job, so a themed or version-changed bullet can never cost a
// capture.

import type { Adapter, AdapterContext, DetectedRegion } from './types';

// Claude renders the tool/diff bullet as ● (U+25CF) or ⏺ (U+23FA) by version/theme; match either,
// or the classifier goes dark and every tool block folds into the prose report (§15.x).
const BULLET = /^[●⏺]/u;
const DIFF_LINE = /^[+-]\s/;
const TOOL_CALL = /^[A-Za-z][\w.]*\(/;

// Claude Code's end-of-turn "※ recap:" line — its one-line turn summary (toggled by the agent's
// own /config), printed below the real output: a meta-summary, not the latest report (§21.1).
const RECAP_LINE = /^※\s*recap:/i;

function stripBullet(line: string): string {
  return line.replace(/^[●⏺]\s*/u, '').trim();
}

export function createClaudeCodeAdapter(): Adapter {
  return {
    id: 'claude-code',
    isMetaSummary(text: string): boolean {
      return RECAP_LINE.test(text);
    },
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, isChrome } = ctx;
      const regions: DetectedRegion[] = [];

      for (let y = startRow; y <= endRow; ) {
        if (isChrome(y) || !BULLET.test(reader.lineText(y).trim())) {
          y++;
          continue;
        }
        const head = stripBullet(reader.lineText(y).trim());
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
        y = j;
      }

      return regions;
    },
  };
}
