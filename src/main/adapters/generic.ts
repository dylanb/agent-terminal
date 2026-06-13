// Generic fallback heuristic (§15.3 / D6). Used only when no specific adapter
// matches. Stable rows across scans are chrome; a *changed* line that is also
// prompt-like is a candidate. Output rows inside closed OSC-133 command spans are
// skipped (they're command output, not agent prompts). On the alt buffer the test
// is deliberately stricter — only an explicit option list or a "Do you want"-class
// phrase trips a single coarse whole-viewport event, never a bare trailing ?/❯ —
// so a pager showing ordinary prose with a "?" does not false-positive.

import type { Adapter, AdapterContext, DetectedRegion } from './types';
import type { CommandSpanRange } from '../commandTracker';

const QUESTION = /\?\s*$/;
const YES_NO = /\[y\/n\]/i;
const OPTION_LINE = /^(?:❯\s*)?\d+\.\s/;
const DO_YOU_WANT = /do you want/i;

function strongPrompt(line: string): boolean {
  return OPTION_LINE.test(line) || YES_NO.test(line) || DO_YOU_WANT.test(line);
}

function insideClosedSpan(y: number, spans: CommandSpanRange[]): boolean {
  return spans.some((s) => y >= s.startRow && y <= s.endRow);
}

export function createGenericAdapter(): Adapter {
  let prevLines = new Set<string>();

  return {
    id: 'generic',
    matches: () => false, // fallback-only; never selected as a specific adapter
    detect(ctx: AdapterContext): DetectedRegion[] {
      const { reader, startRow, endRow, altScreen, closedSpans } = ctx;
      const regions: DetectedRegion[] = [];
      const curLines = new Set<string>();
      for (let y = startRow; y <= endRow; y++) curLines.add(reader.lineText(y).trim());

      if (altScreen) {
        // Coarse whole-viewport event, conservative trigger only.
        const visible: string[] = [];
        for (let y = startRow; y <= endRow; y++) {
          const t = reader.lineText(y).trim();
          if (t) visible.push(t);
        }
        if (visible.some(strongPrompt)) {
          regions.push({
            type: 'permission-prompt',
            source: 'heuristic',
            text: visible.join('\n'),
            startRow,
            endRow,
          });
        }
        prevLines = curLines;
        return regions;
      }

      for (let y = startRow; y <= endRow; y++) {
        const text = reader.lineText(y).trim();
        if (!text) continue;
        if (insideClosedSpan(y, closedSpans)) continue;
        if (prevLines.has(text)) continue; // stable chrome
        if (strongPrompt(text)) {
          regions.push({ type: 'permission-prompt', source: 'heuristic', text, startRow: y, endRow: y });
        } else if (QUESTION.test(text)) {
          regions.push({ type: 'agent-question', source: 'heuristic', text, startRow: y, endRow: y });
        }
      }

      prevLines = curLines;
      return regions;
    },
  };
}
