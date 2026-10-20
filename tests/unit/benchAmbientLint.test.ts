import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

// Drives the project's real eslint.config.mjs: a bench module (#180) takes its env, roots, clock and randomness
// as arguments, so a test can fix them; only the side-effecting entry reads them from the process.
const eslint = new ESLint({ cwd: resolve(__dirname, '../..') });

const RESTRICTED = /^no-restricted-(properties|imports|syntax): \d+$/;

async function ambientErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => `${m.ruleId}: ${m.line}`);
}

const VIOLATIONS: [string, string][] = [
  ['process.env', 'export const home = process.env.HOME;\n'],
  ['destructured process.env', 'const { env } = process;\nexport const home = env.HOME;\n'],
  ['process.cwd()', 'export const here = process.cwd();\n'],
  ['os.homedir()', "import os from 'node:os';\nexport const home = os.homedir();\n"],
  ['imported homedir', "import { homedir } from 'node:os';\nexport const home = homedir();\n"],
  ['the ambient config root', "import { userConfigRoot } from './userConfig';\nexport const root = userConfigRoot();\n"],
  ['a zero-argument config-dir helper', "import { userConfigLoopsV2Dir } from './userConfig';\nexport const d = userConfigLoopsV2Dir();\n"],
  ['env imported from process', "import { env } from 'node:process';\nexport const home = env.HOME;\n"],
  ['cwd imported from process', "import { cwd } from 'process';\nexport const here = cwd();\n"],
  ['homedir through a renamed os import', "import nodeOs from 'node:os';\nexport const home = nodeOs.homedir();\n"],
  ['performance.now()', 'export const t = performance.now();\n'],
  ['Date() without new', 'export const t = Date();\n'],
  ['process.hrtime', 'export const t = process.hrtime.bigint();\n'],
  ['Date.now()', 'export const t = Date.now();\n'],
  ['new Date()', 'export const t = new Date();\n'],
  ['Math.random()', 'export const r = Math.random();\n'],
];

describe('bench modules read no ambient state (#180)', () => {
  for (const [what, code] of VIOLATIONS) {
    it(`flags ${what} in a bench module`, async () => {
      expect(await ambientErrors(code, 'src/main/benchRun.ts')).toEqual([expect.stringMatching(RESTRICTED)]);
    });
  }

  it('accepts the same values taken as arguments', async () => {
    const code =
      "import { userConfigLoopsV2Dir, userConfigRootFrom } from './userConfig';\n" +
      'export function f(env: NodeJS.ProcessEnv, home: string, clock: { now(): number }, cwd: string) {\n' +
      '  return [env.HOME, userConfigRootFrom(env, home), userConfigLoopsV2Dir(home), clock.now(), new Date(clock.now()), cwd, process.execPath];\n}\n';
    expect(await ambientErrors(code, 'src/main/benchRun.ts')).toEqual([]);
  });

  it('accepts ambient reads in the side-effecting entry and outside bench modules', async () => {
    const code = "import os from 'node:os';\nexport const v = [process.env.HOME, process.cwd(), os.homedir(), Date.now(), Math.random()];\n";
    expect(await ambientErrors(code, 'src/main/benchMainEntry.ts')).toEqual([]);
    expect(await ambientErrors(code, 'src/main/index.ts')).toEqual([]);
  });

  const SHELL: [string, string][] = [
    ['an exec import', "import { exec } from 'node:child_process';\nexec('git status');\n"],
    ['an execSync import', "import { execSync } from 'child_process';\nexecSync('git status');\n"],
    ['a shell: true spawn', "import { spawn } from 'node:child_process';\nspawn('git', ['status'], { shell: true });\n"],
    ['a string shell spawn', "import { spawn } from 'node:child_process';\nspawn('git', ['status'], { shell: '/bin/sh' });\n"],
    ['a quoted shell key', "import { spawn } from 'node:child_process';\nspawn('git', ['status'], { 'shell': true });\n"],
    ['a default child_process import', "import cp from 'node:child_process';\ncp.execSync('git status');\n"],
  ];
  for (const [what, code] of SHELL) {
    for (const file of ['src/main/benchPrepare.ts', 'src/main/benchMainEntry.ts']) {
      it(`flags ${what} in ${file}`, async () => {
        expect(await ambientErrors(code, file)).toEqual([expect.stringMatching(RESTRICTED)]);
      });
    }
  }

  it('accepts an argv-only spawn', async () => {
    const code =
      "import { execFile, spawn } from 'node:child_process';\n" +
      "export function f(c: string, env: NodeJS.ProcessEnv) { execFile('git', ['cat-file', '-e', '--end-of-options', c]); spawn('app', [c], { env, shell: false }); }\n";
    expect(await ambientErrors(code, 'src/main/benchPrepare.ts')).toEqual([]);
  });
});
