import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

// Drives the project's real eslint.config.mjs, as the pre-commit hook and CI do, so it pins the rule's verdict on
// the source it governs. CODE-STANDARDS.md § untrusted data across a process boundary (CWE-78).
const RULE = 'local/no-gh-body-argv';
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function bodyArgvErrors(code: string, filePath = 'src/main/probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => m.ruleId === RULE).length;
}

describe('local/no-gh-body-argv — a gh body travels on stdin, never as a command-line argument', () => {
  it.each([
    ['--body', "export const a = (body: string) => ['pr', 'create', '--title', 't', '--body', body];\n"],
    ['-b', "export const a = (body: string) => ['issue', 'comment', '7', '-b', body];\n"],
    ['--body=', "export const a = (body: string) => ['pr', 'edit', '7', `--body=${body}`];\n"],
    ['an api body= field', "export const a = (body: string) => ['api', 'repos/o/r/issues/7/comments', '-f', `body=${body}`];\n"],
    ['an api body= literal', "export const a = ['api', 'repos/o/r/issues/7/comments', '--raw-field', 'body=fixed'];\n"],
  ])('flags a gh argv that passes the body as %s', async (_form, code) => {
    expect(await bodyArgvErrors(code)).toBe(1);
  });

  it.each([
    ['--body-file -', "export const a = ['pr', 'create', '--title', 't', '--body-file', '-'];\n"],
    ["api --input -", "export const a = ['api', '--method', 'POST', 'repos/o/r/issues/7/comments', '--input', '-'];\n"],
    ["git's own -b", "export const a = ['checkout', '-b', 'feature'];\n"],
  ])('passes %s', async (_form, code) => {
    expect(await bodyArgvErrors(code)).toBe(0);
  });

  it('applies to repo tooling scripts too', async () => {
    expect(await bodyArgvErrors("export const a = (b) => ['pr', 'comment', '7', '--body', b];\n", 'scripts/probe.mjs')).toBe(1);
  });
});
