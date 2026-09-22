import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

// Drives the project's real eslint.config.mjs through the public lint API — the same resolution the husky
// pre-commit hook and CI use — so this pins the rule's observable verdict, not its wiring. Every fixture below
// is a string literal (the rule scans comments only), so linting this file cannot self-trip the rule.
const RULE = 'local/no-todo-comments';
const eslint = new ESLint({ cwd: resolve(__dirname, '../..') });

async function markerErrors(code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: 'probe.ts' });
  return result.messages.filter((m) => m.ruleId === RULE).length;
}

describe('local/no-todo-comments — forbids code TODO/FIXME deferral comments (CLAUDE.md)', () => {
  it('flags an uppercase TODO line comment', async () => {
    expect(await markerErrors('// TODO(dylan): defer this\nexport const a = 1;\n')).toBe(1);
  });

  it('flags a FIXME block comment', async () => {
    expect(await markerErrors('/* FIXME: broken */\nexport const a = 1;\n')).toBe(1);
  });

  it('flags a marker that appears mid-comment', async () => {
    expect(await markerErrors('// deduped per key (TODO(dylanb) #123)\nexport const a = 1;\n')).toBe(1);
  });

  it('passes clean code with no marker comment', async () => {
    expect(await markerErrors('export const a = 1;\n')).toBe(0);
  });

  it('does NOT flag the lowercase "todo" domain word in prose', async () => {
    expect(await markerErrors('// curate a review-todo subset from the repo-scoped todo list\nexport const a = 1;\n')).toBe(0);
  });

  it('does NOT flag the capitalized "Todo" proper noun', async () => {
    expect(await markerErrors('// the Todo pane mirrors the capture pane\nexport const a = 1;\n')).toBe(0);
  });

  it('does NOT flag a TODO_-prefixed identifier (code, not a comment)', async () => {
    expect(await markerErrors('export const TODO_UNDO_MS = 60000;\n')).toBe(0);
  });

  // The rule must never exclude documentation of a legitimate external invariant/contract — one of the two
  // comment kinds CODE-STANDARDS sanctions. Such a comment cites a spec clause or protocol and carries no
  // deferral marker, so it passes clean; these pin that guarantee against a future over-broadening of MARKER.
  it('does NOT flag a marker-free external-invariant comment (a §n citation + tracked-issue pointer)', async () => {
    expect(
      await markerErrors(
        '// §27.12 — after a relaunch the bootstrap map is empty, so verifyBootstrap skips the PR-identity check;\n' +
          '// a naive re-seed is unsafe (repo-scoped, could retarget the ready command). Tracked in #999.\n' +
          'export const a = 1;\n',
      ),
    ).toBe(0);
  });

  it('does NOT flag a marker-free untestability site pointer', async () => {
    expect(
      await markerErrors('// untestable without a real terminal; verified in the §F e2e — tracked in #153\nexport const a = 1;\n'),
    ).toBe(0);
  });

  it('allows a legitimate external-contract reference to the literal marker via an explicit eslint-disable', async () => {
    // The rare residue: a comment whose SUBJECT is the marker token as an external contract (git's rebase
    // instruction sheet). An explicit, auditable per-line disable permits it without weakening the ban.
    const code =
      '// eslint-disable-next-line local/no-todo-comments\n' +
      "// git writes its rebase instruction sheet with a leading TODO keyword this parser must match.\n" +
      'export const a = 1;\n';
    expect(await markerErrors(code)).toBe(0);
  });
});
