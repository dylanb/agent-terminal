// CWE-117 / CWE-1007 / CWE-116: one strip for every repo-supplied string that reaches a human-facing
// sink (status-bar title; loop status → panel, OS notification, audit), so no two sinks sanitize the
// same untrusted text differently. ZWJ (U+200D) and ZWNJ (U+200C) are deliberately NOT stripped — they
// carry legitimate emoji and Indic/Arabic shaping meaning.
//
// Cc = C0/C1/DEL controls. The rest are the bidi controls/marks/isolates (Trojan Source, CVE-2021-42574),
// the line/paragraph separators, and the zero-width space / BOM. Built from escapes so no unsafe code
// point is ever a literal in this file.
const DISPLAY_UNSAFE = new RegExp(
  '[\\p{Cc}\\u061C\\u200B\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'gu',
);

export function stripDisplayControlChars(text: string): string {
  return text.replace(DISPLAY_UNSAFE, ' ');
}
