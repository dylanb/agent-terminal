import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

// Drives the project's real eslint.config.mjs: every main-process module spawns with argv only, never shell
// text (CWE-78).
const eslint = new ESLint({ cwd: resolve(__dirname, '../..') });

const RESTRICTED = /^no-restricted-(imports|syntax): \d+$/;

async function errors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => `${m.ruleId}: ${m.line}`);
}

const FILES = ['src/main/gitBranch.ts', 'src/main/index.ts', 'src/main/flow/nested.ts'];

const SHELL: [string, string][] = [
  ['an exec import', "import { exec } from 'node:child_process';\nexec('git status');\n"],
  ['an execSync import', "import { execSync } from 'child_process';\nexecSync('git status');\n"],
  ['a default child_process import', "import cp from 'node:child_process';\ncp.execSync('git status');\n"],
  ['a shell: true spawn', "import { spawn } from 'node:child_process';\nspawn('git', ['status'], { shell: true });\n"],
  ['a string shell execFile', "import { execFile } from 'node:child_process';\nexecFile('git', ['status'], { shell: '/bin/sh' });\n"],
  ['a quoted shell key on execFileSync', "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status'], { 'shell': true });\n"],
  ['a shell spawnSync', "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status'], { cwd: '/', shell: true });\n"],
];

describe('main-process modules spawn with argv only (CWE-78)', () => {
  for (const [what, code] of SHELL) {
    for (const file of FILES) {
      it(`flags ${what} in ${file}`, async () => {
        expect(await errors(code, file)).toEqual([expect.stringMatching(RESTRICTED)]);
      });
    }
  }

  it('accepts argv-only spawns and a shell field that is not a spawn option', async () => {
    const code =
      "import { execFile, execFileSync, spawn } from 'node:child_process';\n" +
      'export function f(c: string, env: NodeJS.ProcessEnv, configure: (o: { shell: string }) => void) {\n' +
      "  execFile('git', ['cat-file', '-e', c]); execFileSync('git', ['status'], { shell: false }); spawn('app', [c], { env });\n" +
      "  configure({ shell: '/bin/zsh' });\n}\n";
    for (const file of FILES) expect(await errors(code, file)).toEqual([]);
  });
});
