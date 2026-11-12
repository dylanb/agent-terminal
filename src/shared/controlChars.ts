// CWE-117 / CWE-1007 / CWE-116: the strip the status-bar title and loop-status paths share before a
// human-facing sink, so the sinks cannot sanitize differently. ZWJ (U+200D) and ZWNJ (U+200C) are
// deliberately kept — they carry legitimate emoji and Indic/Arabic shaping meaning.
const DISPLAY_UNSAFE = new RegExp(
  '[\\p{Cc}\\u061C\\u200B\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'gu',
);

export function stripDisplayControlChars(text: string): string {
  return text.replace(DISPLAY_UNSAFE, ' ');
}

/** §18.7.6 (CWE-400) */
export const MAX_ECHOED_REASON_LENGTH = 200;

/** §18.7.6 (CWE-400) */
export const MAX_ECHOED_PATH_LENGTH = 512;

/** §18.7.6 (CWE-400) */
export const MAX_ECHOED_LOCK_REASON_LENGTH = MAX_ECHOED_REASON_LENGTH + MAX_ECHOED_PATH_LENGTH;

/** §18.7.6 (CWE-400) */
export const MAX_ECHOED_LOAD_ERROR_LENGTH = 1024;

// §18.7.6 (CWE-116/117/1007)
const JOINERS = new RegExp('[\\u200C\\u200D]', 'gu');

export function displaySafeEcho(value: string, max: number): string {
  return stripDisplayControlChars(value).replace(JOINERS, '').slice(0, max);
}

// ECMA-48 CSI and OSC control sequences, 7- and 8-bit.
const TERMINAL_ESCAPE = new RegExp('(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]|(?:\\u001b\\]|\\u009d)[^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u001b\\\\|\\u009c|$)', 'gu');

const INVISIBLE_FORMAT = new RegExp('[\\p{Cf}\\p{Cs}]', 'gu');

export function removeDisplayUnsafe(text: string): string {
  return text.replace(TERMINAL_ESCAPE, '').replace(DISPLAY_UNSAFE, '').replace(INVISIBLE_FORMAT, '');
}
