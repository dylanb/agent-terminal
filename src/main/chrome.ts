// Chrome detection (§15.x). Agent-UI furniture is recognized by structure and a learned
// profile, NEVER by hardcoded theme glyphs — the chrome is user-customizable, so any
// theme-specific glyph constant would silently mis-detect a re-themed agent.

import type { ShadowReader } from './shadow';

const RULE_WIDTH_FRACTION = 0.5;
const MIN_RULE_LEN = 12;

/** Stock Claude markers, grown by the user (§15.x). `⎿` is deliberately absent: it rides
 *  ⏺ tool/diff blocks as content, not chrome. */
export const DEFAULT_CHROME_MARKERS: readonly string[] = ['❯', '✻', '⏵⏵'];

const LEADING_MARKER = /^[^\s\p{L}\p{N}_]+/u;

export function isRuleLine(text: string, cols: number): boolean {
  const t = text.trim();
  const threshold = Math.max(MIN_RULE_LEN, Math.floor(cols * RULE_WIDTH_FRACTION));
  if (t.length < threshold) return false;
  const first = t[0];
  if (/[\p{L}\p{N}\s_]/u.test(first)) return false;
  for (const ch of t) if (ch !== first) return false;
  return true;
}

/** The line's leading symbol token, or '' when it starts with text/blank. */
export function leadingMarker(text: string): string {
  return text.trim().match(LEADING_MARKER)?.[0] ?? '';
}

/** Unique leading markers across a captured sample — the profile "mark as chrome" adds. */
export function learnMarkers(sample: string): string[] {
  const out = new Set<string>();
  for (const line of sample.split('\n')) {
    const m = leadingMarker(line);
    if (m) out.add(m);
  }
  return [...out];
}

export function isChromeLine(text: string, markers: readonly string[]): boolean {
  const m = leadingMarker(text);
  return m !== '' && markers.includes(m);
}

/**
 * The first row of the bottom interactive chrome (composer or permission prompt) in
 * [startRow, endRow], or endRow+1 when there is none. A rule *pair* is required: a lone
 * full-width separator inside a report must not be mistaken for the composer frame.
 */
export function composerTop(
  reader: Pick<ShadowReader, 'cols' | 'baseY' | 'lineText'>,
  startRow: number,
  endRow: number,
): number {
  if (endRow < startRow) return endRow + 1;
  const cols = reader.cols();
  const viewTop = Math.max(startRow, reader.baseY());
  let bottom = -1;
  for (let y = endRow; y >= viewTop; y--) {
    if (isRuleLine(reader.lineText(y), cols)) {
      bottom = y;
      break;
    }
  }
  if (bottom < 0) return endRow + 1;
  for (let y = bottom - 1; y >= viewTop; y--) {
    if (isRuleLine(reader.lineText(y), cols)) return y;
  }
  return endRow + 1; // one rule only — a content separator, not a framed region
}

/**
 * The highest row sealed final by a turn-complete composer (§15.3), or null when no
 * composer frames the bottom — the turn may still be streaming, so nothing is witnessed sealed.
 */
export function completedTurnFrontier(
  reader: Pick<ShadowReader, 'cols' | 'baseY' | 'lineText'>,
  startRow: number,
  endRow: number,
): number | null {
  const top = composerTop(reader, startRow, endRow);
  return top <= endRow ? top - 1 : null;
}

/**
 * A per-row chrome predicate over [startRow, endRow]. Continuation MUST key on the block
 * head, not the indented glyph: a `⎿` under a non-chrome `⏺` tool/diff head stays content,
 * else chrome continuation would swallow tool output (§15.x).
 */
export function chromeRows(
  reader: Pick<ShadowReader, 'cols' | 'baseY' | 'lineText'>,
  startRow: number,
  endRow: number,
  markers: readonly string[],
): (row: number) => boolean {
  const composerStart = composerTop(reader, startRow, endRow);
  const chrome = new Set<number>();
  let inChromeBlock = false;
  for (let y = startRow; y <= endRow; y++) {
    if (y >= composerStart) {
      chrome.add(y);
      continue;
    }
    const text = reader.lineText(y);
    if (text.trim() === '') continue;
    if (/^\s/.test(text)) {
      // Indented: a continuation, or its own marker (the status strip is indented but
      // starts with ⏵⏵); MUST NOT open a block for the lines below it.
      if (inChromeBlock || isChromeLine(text, markers)) chrome.add(y);
      continue;
    }
    inChromeBlock = isChromeLine(text, markers);
    if (inChromeBlock) chrome.add(y);
  }
  return (row) => chrome.has(row);
}
