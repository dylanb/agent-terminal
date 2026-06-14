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
/** Status-strip lines tolerated between the composer's bottom rule and the last row. */
const BOTTOM_BAND = 3;

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
 * The first row of the bottom-anchored, rule-framed composer in [startRow, endRow],
 * or endRow+1 when there is none. The composer's bottom rule must sit flush to the
 * viewport bottom (within BOTTOM_BAND of the last row) so a stray rule scrolled up
 * in the transcript is never mistaken for the frame; the top rule is the next rule
 * above it within the viewport (the composer body grows arbitrarily between them).
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
  for (let y = endRow; y >= Math.max(viewTop, endRow - BOTTOM_BAND); y--) {
    if (isRuleLine(reader.lineText(y), cols)) {
      bottom = y;
      break;
    }
  }
  if (bottom < 0) return endRow + 1;
  for (let y = bottom - 1; y >= viewTop; y--) {
    if (isRuleLine(reader.lineText(y), cols)) return y;
  }
  return bottom;
}
