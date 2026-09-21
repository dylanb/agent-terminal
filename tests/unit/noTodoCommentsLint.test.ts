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
});
