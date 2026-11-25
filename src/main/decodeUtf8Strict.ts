/** A fatal UTF-8 decode: an invalid byte sequence THROWS rather than becoming U+FFFD. A reader of untrusted
 *  serialized bytes (git `-z` output, the capabilities file) must surface malformed input, never silently
 *  normalize it into a different — and fail-away — value. One definition for every such reader. */
export type ByteOrderMark = 'strip' | 'keep';

const IGNORE_BOM: Record<ByteOrderMark, boolean> = { strip: false, keep: true };

export function decodeUtf8Strict(bytes: Uint8Array, byteOrderMark: ByteOrderMark = 'strip'): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: IGNORE_BOM[byteOrderMark] }).decode(bytes);
}
