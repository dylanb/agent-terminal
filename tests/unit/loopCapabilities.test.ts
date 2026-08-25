import { describe, it, expect } from 'vitest';
import { parseLoopCapabilities } from '../../src/main/loopCapabilities';

const WELL_FORMED = `test_globs:
  - tests/**/*.test.ts
  - tests/**
test_command: pnpm test
build_command: pnpm run build
select_template: pnpm test {files}
`;

function rejectReason(text: string): string {
  const r = parseLoopCapabilities(text);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected rejection');
  return r.reason;
}

describe('parseLoopCapabilities (§28.5.4)', () => {
  it('parses a well-formed file into the four fields (snake → camel)', () => {
    const r = parseLoopCapabilities(WELL_FORMED);
    expect(r).toEqual({
      ok: true,
      value: {
        testGlobs: ['tests/**/*.test.ts', 'tests/**'],
        testCommand: 'pnpm test',
        buildCommand: 'pnpm run build',
        selectTemplate: 'pnpm test {files}',
      },
    });
  });

  it('omits selectTemplate when select_template is absent', () => {
    const r = parseLoopCapabilities('test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n');
    expect(r).toEqual({
      ok: true,
      value: { testGlobs: ['tests/**'], testCommand: 't', buildCommand: 'b' },
    });
  });

  it('rejects a missing / empty / non-array / bad-element test_globs, naming the field', () => {
    expect(rejectReason('test_command: t\nbuild_command: b\n')).toContain('test_globs');
    expect(rejectReason('test_globs: []\ntest_command: t\nbuild_command: b\n')).toContain('test_globs');
    expect(rejectReason('test_globs: nope\ntest_command: t\nbuild_command: b\n')).toContain('test_globs');
    expect(rejectReason('test_globs: [1]\ntest_command: t\nbuild_command: b\n')).toContain('test_globs');
    expect(rejectReason('test_globs: ["  "]\ntest_command: t\nbuild_command: b\n')).toContain('test_globs');
  });

  it('rejects test_globs using syntax globMatch does not honor (braces, char-classes, partial **) — fail LOUD, not fail-away', () => {
    // globMatch supports only *, ?, and a WHOLE-segment **. A brace/char-class/partial-** glob is accepted-but-
    // treated-literally, so it matches nothing and the §28.5.1 frozen check would read as "no test changed" — a
    // fail-AWAY, the exact direction §28.5.1 swears off. Reject it at parse time so it surfaces as malformed.
    expect(rejectReason('test_globs: ["tests/*.{test,spec}.ts"]\ntest_command: t\nbuild_command: b\n')).toContain(
      'test_globs',
    );
    expect(rejectReason('test_globs: ["tests/[ab].test.ts"]\ntest_command: t\nbuild_command: b\n')).toContain(
      'test_globs',
    );
    expect(rejectReason('test_globs: ["tests/**foo/x.ts"]\ntest_command: t\nbuild_command: b\n')).toContain(
      'test_globs',
    );
  });

  it('accepts the supported grammar — *, ?, and whole-segment ** — unchanged', () => {
    const r = parseLoopCapabilities('test_globs: ["tests/**", "**/*_test.go", "src/a?c/*.spec.ts"]\ntest_command: t\nbuild_command: b\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.testGlobs).toEqual(['tests/**', '**/*_test.go', 'src/a?c/*.spec.ts']);
  });

  it('rejects a missing or blank test_command / build_command, naming the field', () => {
    expect(rejectReason('test_globs: [tests/**]\nbuild_command: b\n')).toContain('test_command');
    expect(rejectReason('test_globs: [tests/**]\ntest_command: "  "\nbuild_command: b\n')).toContain('test_command');
    expect(rejectReason('test_globs: [tests/**]\ntest_command: t\n')).toContain('build_command');
    expect(rejectReason('test_globs: [tests/**]\ntest_command: t\nbuild_command: "  "\n')).toContain('build_command');
  });

  it('rejects a present-but-invalid select_template, naming the field', () => {
    expect(rejectReason('test_globs: [tests/**]\ntest_command: t\nbuild_command: b\nselect_template: 5\n')).toContain(
      'select_template',
    );
    expect(
      rejectReason('test_globs: [tests/**]\ntest_command: t\nbuild_command: b\nselect_template: "  "\n'),
    ).toContain('select_template');
  });

  it('rejects malformed yaml with a surfaced reason', () => {
    expect(rejectReason('test_globs: [unterminated\n')).toContain('malformed yaml');
  });

  it('rejects a top-level scalar or sequence (not a mapping)', () => {
    expect(rejectReason('42\n')).toContain('mapping');
    expect(rejectReason('- a\n- b\n')).toContain('mapping');
  });

  it('rejects an unknown top-level key (closed key set)', () => {
    const reason = rejectReason('test_globs: [tests/**]\ntest_command: t\nbuild_command: b\nextra: 1\n');
    expect(reason).toContain('unknown key');
    expect(reason).toContain('extra');
  });

  it('rejects a __proto__ / constructor key without polluting the prototype', () => {
    expect(rejectReason('__proto__:\n  polluted: true\ntest_globs: [tests/**]\ntest_command: t\nbuild_command: b\n')).toContain(
      'unknown key',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(rejectReason('constructor: x\ntest_globs: [tests/**]\ntest_command: t\nbuild_command: b\n')).toContain(
      'unknown key',
    );
  });

  it('rejects duplicate mapping keys (js-yaml raises, surfaced as malformed)', () => {
    expect(rejectReason('test_globs: [a]\ntest_globs: [b]\ntest_command: t\nbuild_command: b\n')).toContain(
      'malformed yaml',
    );
  });

  it('rejects an over-large glob list or an over-long glob (defense-in-depth caps)', () => {
    const many = Array.from({ length: 257 }, (_v, i) => `  - g${i}`).join('\n');
    expect(rejectReason(`test_globs:\n${many}\ntest_command: t\nbuild_command: b\n`)).toContain('test_globs');
    const long = 'x'.repeat(1025);
    expect(rejectReason(`test_globs: ["${long}"]\ntest_command: t\nbuild_command: b\n`)).toContain('test_globs');
  });
});
