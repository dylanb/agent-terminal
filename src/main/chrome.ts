// Chrome detection (§15.x). Agent-UI furniture — the input composer, status strip,
// spinner, command echoes — is recognized by structure and a learned profile, NEVER
// by hardcoded theme glyphs (the chrome is user-customizable). Two theme-independent
// signals:
//   (1) Geometry — the composer is a full-width-rule-framed region pinned to the
//       bottom of the viewport; from its top rule to the last row is chrome (composerTop).
//   (2) Signature — a line whose leading symbol token is a known marker is chrome
//       wherever it appears (caret echoes, the spinner, the mode strip). Markers are
//       seeded with the stock Claude set and grown by the user "marking as chrome".
//
// A "rule" generalizes past `─`: any single non-alphanumeric glyph repeated across
// most of the width, so `═══`/`———`/`---` themes all read as the same frame.

import type { ShadowReader } from './shadow';

/** Fraction of the terminal width a rule must span to count as a composer frame. */
const RULE_WIDTH_FRACTION = 0.5;
const MIN_RULE_LEN = 12;

/** Stock Claude markers — a convenience seed; the profile is grown by the user (§15.x).
 *  `⎿` is deliberately absent: it rides ⏺ tool/diff blocks as content, not chrome. */
export const DEFAULT_CHROME_MARKERS: readonly string[] = ['❯', '✻', '⏵⏵'];

/** A leading run of non-space, non-letter, non-number glyphs — the line's symbol token. */
const LEADING_MARKER = /^[^\s\p{L}\p{N}_]+/u;

export function isRuleLine(text: string, cols: number): boolean {
  const t = text.trim();
  const threshold = Math.max(MIN_RULE_LEN, Math.floor(cols * RULE_WIDTH_FRACTION));
  if (t.length < threshold) return false;
  const first = t[0];
  // A rule glyph is non-alphanumeric; a run of one such glyph is the frame.
  if (/[\p{L}\p{N}\s_]/u.test(first)) return false;
  for (const ch of t) if (ch !== first) return false;
  return true;
}

/** The line's leading symbol token, or '' when it starts with text/blank. */
export function leadingMarker(text: string): string {
  return text.trim().match(LEADING_MARKER)?.[0] ?? '';
}

/** Unique leading markers across a captured sample — what "mark as chrome" learns. */
export function learnMarkers(sample: string): string[] {
  const out = new Set<string>();
  for (const line of sample.split('\n')) {
    const m = leadingMarker(line);
    if (m) out.add(m);
  }
  return [...out];
}

/** True when the line's leading marker is in the active profile. */
export function isChromeLine(text: string, markers: readonly string[]): boolean {
  const m = leadingMarker(text);
  return m !== '' && markers.includes(m);
}

/**
 * The first row of the bottom interactive chrome (composer or permission prompt) in
 * [startRow, endRow], or endRow+1 when there is none. The bottom region is framed by
 * **full-width horizontal rules** (the `❯` selector lives inside the frame); a content
 * box uses corners/verticals, never a bare full-width rule, so the two never collide.
 * Rule: the chrome is **everything from the top rule of the bottom-most rule pair down
 * to the screen bottom** — however tall the prompt's option/help tail. A rule *pair* is
 * required so a lone full-width separator inside a report (with the real composer pair
 * below it) is not mistaken for the frame. (Capture anything inside it manually.)
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
    if (isRuleLine(reader.lineText(y), cols)) return y; // top rule of the bottom-most pair
  }
  return endRow + 1; // only one rule found — a content separator, not a framed region
}

/**
 * The stability frontier witnessed by a turn-complete composer (§15.3 / v2.22). When the
 * agent has rendered its input composer at the bottom of the view, the turn is done and
 * everything above the composer's top rule is final, so this returns `composerTop - 1` —
 * the highest row sealed by that witness. Returns null when no composer frames the bottom:
 * the turn may still be streaming, so nothing in the window is witnessed sealed.
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
 * A per-row chrome predicate over [startRow, endRow], folding both signals plus
 * **continuation**: a chrome marker line consumes the indented lines beneath it as
 * chrome too (a `❯ /command` echo and its `⎿` results). Crucially, a `⎿` under a
 * *non-chrome* head (an `⏺` tool/diff block) stays content — chrome continuation keys
 * on the block's head, not the glyph, so it can't swallow tool output (§15.x).
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
    if (text.trim() === '') continue; // blank: neither content nor a block boundary
    if (/^\s/.test(text)) {
      // Indented: a continuation of a chrome head, or its own marker (the status strip
      // is indented but starts with ⏵⏵). Doesn't open a block for the lines below it.
      if (inChromeBlock || isChromeLine(text, markers)) chrome.add(y);
      continue;
    }
    inChromeBlock = isChromeLine(text, markers);
    if (inChromeBlock) chrome.add(y);
  }
  return (row) => chrome.has(row);
}
