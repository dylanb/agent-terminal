import { describe, it, expect } from 'vitest';
import { shellQuote } from '../../src/shared/shellQuote';

// The single shell-quoting primitive shared by main (shim/PATH generation) and renderer (drop paste).
// It wraps a value as one POSIX single-quoted literal so no embedded metacharacter is ever evaluated
// (CWE-78). It is lossless: control-char stripping and other paste sanitization are separate concerns.
describe('shellQuote (shared POSIX single-quote primitive)', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('/tmp/a.txt')).toBe("'/tmp/a.txt'");
  });

  it('keeps spaces intact inside the quotes', () => {
    expect(shellQuote('/tmp/my shot.png')).toBe("'/tmp/my shot.png'");
  });

  it('escapes an embedded single quote POSIX-style', () => {
    expect(shellQuote("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });

  it('renders shell metacharacters inert by quoting them, not deleting them', () => {
    expect(shellQuote('$(rm -rf ~); `x` & | > <')).toBe("'$(rm -rf ~); `x` & | > <'");
  });

  it('quotes the empty string as an empty literal', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('does not strip control characters (lossless — sanitization is a separate layer)', () => {
    expect(shellQuote('a\nb')).toBe("'a\nb'");
  });
});
