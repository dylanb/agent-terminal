// Claude Code adapter (§15.3 / D5). Deterministic line patterns on the normal
// (scrolling-transcript) buffer. Recognizes box-drawn permission prompts, ⏺/⎿
// tool-use blocks, ⏺ questions, and ± diffs. The input box is chrome — never
// emitted as content. Assertions in tests are on emitted events, so the exact
// patterns here can change as long as the detected event types/text are stable.

import type { Adapter, AdapterContext, DetectedRegion } from './types';

const TOP_BORDER = /^[╭┌]/;
const BOTTOM_BORDER = /^[╰└]/;
const SIDE = /^│(.*)│?\s*$/;
const BULLET = '⏺';
const OPTION_LINE = /(?:❯\s*)?\d+\.\s/;
const DIFF_LINE = /^[+-]\s/;

function innerOf(boxLine: string): string {
  const m = SIDE.exec(boxLine.trim());
  return (m ? m[1] : boxLine).replace(/[│]/g, '').trim();
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
      const { reader, startRow, endRow } = ctx;
      const regions: DetectedRegion[] = [];

      for (let y = startRow; y <= endRow; ) {
        const raw = reader.lineText(y);
        const trimmed = raw.trim();

        if (TOP_BORDER.test(trimmed)) {
          let j = y + 1;
          while (j <= endRow && !BOTTOM_BORDER.test(reader.lineText(j).trim())) j++;
          const inner: string[] = [];
          for (let k = y + 1; k < j; k++) inner.push(innerOf(reader.lineText(k)));
          const region = classifyBox(inner, y, Math.min(j, endRow));
          if (region) regions.push(region);
          y = j + 1;
          continue;
        }

        if (trimmed.startsWith(BULLET)) {
          let j = y + 1;
          // Continuation rows are indented (⎿ / further-indented diff lines).
          while (j <= endRow && /^\s+\S/.test(reader.lineText(j))) j++;
          const block: string[] = [];
          for (let k = y; k < j; k++) block.push(reader.lineText(k).trim());
          regions.push(classifyBullet(trimmed, block, y, j - 1));
          y = j;
          continue;
        }

        y++;
      }

      return regions;
    },
  };
}

function classifyBox(inner: string[], startRow: number, endRow: number): DetectedRegion | null {
  const content = inner.filter((l) => l.length > 0);
  if (content.length === 0) return null;
  const joined = content.join('\n');

  const hasOptions = content.some((l) => OPTION_LINE.test(l));
  const hasDoYouWant = /do you want/i.test(joined);
  // An input box is just a "> …" prompt with no question/options — pure chrome.
  const isInputBox = !hasOptions && !hasDoYouWant && content.every((l) => /^>(\s|$)/.test(l));
  if (isInputBox) return null;

  if (hasOptions || hasDoYouWant) {
    return { type: 'permission-prompt', source: 'shadow-scan', text: joined, startRow, endRow };
  }
  if (content[content.length - 1].endsWith('?')) {
    return { type: 'agent-question', source: 'shadow-scan', text: joined, startRow, endRow };
  }
  return null;
}

function classifyBullet(head: string, block: string[], startRow: number, endRow: number): DetectedRegion {
  const text = block.join('\n');
  const continuations = block.slice(1).map((l) => l.replace(/^⎿\s*/, '').trim());
  if (continuations.some((l) => DIFF_LINE.test(l))) {
    return { type: 'diff', source: 'shadow-scan', text, startRow, endRow };
  }
  if (head.endsWith('?')) {
    return { type: 'agent-question', source: 'shadow-scan', text, startRow, endRow };
  }
  return { type: 'tool-use', source: 'shadow-scan', text, startRow, endRow };
}
