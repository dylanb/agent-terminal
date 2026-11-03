import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const SEAM_ONLY = /decides from its seam values only/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });
const CORE = 'src/main/testProof.ts';

async function ruleErrors(code: string, filePath = CORE): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => SEAM_ONLY.test(m.message)).length;
}

describe('the test-proof core reaches processes, the filesystem, the network, git and gh only through its ports', () => {
  it('flags process, filesystem, network and command access in the core', async () => {
    expect({
      childProcess: await ruleErrors("import { spawn } from 'node:child_process';\n"),
      bareChildProcess: await ruleErrors("import { execFile } from 'child_process';\n"),
      fs: await ruleErrors("import { readFileSync } from 'node:fs';\n"),
      fsPromises: await ruleErrors("import { readFile } from 'node:fs/promises';\n"),
      os: await ruleErrors("import { tmpdir } from 'node:os';\n"),
      appCommand: await ruleErrors("import { runAppCommand } from './appCommand';\n"),
      adapters: await ruleErrors("import { createRealPorts } from './testProofPorts';\n"),
      prLookup: await ruleErrors("import { createRealPullRequestLookup } from './pullRequestLookup';\n"),
      repository: await ruleErrors("import { resolveGitHubRepository } from './githubRepository';\n"),
      readers: await ruleErrors("import { readVitestReport } from './testProofResults';\n"),
      reExport: await ruleErrors("export { readFileSync } from 'node:fs';\n"),
      processGlobal: await ruleErrors('export const argv = process.argv;\n'),
      processModule: await ruleErrors("import { argv } from 'node:process';\n"),
      dynamicImport: await ruleErrors("export const load = () => import('node:fs/promises');\n"),
      require: await ruleErrors("export const cp = require('node:child_process');\n"),
      https: await ruleErrors("import { request } from 'node:https';\n"),
      bareHttp: await ruleErrors("import { request } from 'http';\n"),
      net: await ruleErrors("import { connect } from 'node:net';\n"),
      fetch: await ruleErrors("export const r = () => fetch('https://api.github.com/x', { method: 'POST' });\n"),
      webSocket: await ruleErrors("export const w = () => new WebSocket('wss://example.test');\n"),
      renamedCore: await ruleErrors("import { spawn } from 'node:child_process';\n", 'src/main/testProofCore.ts'),
    }).toEqual({ childProcess: 1, bareChildProcess: 1, fs: 1, fsPromises: 1, os: 1, appCommand: 1, adapters: 1, prLookup: 1, repository: 1, readers: 1, reExport: 1, processGlobal: 1, processModule: 1, dynamicImport: 1, require: 1, https: 1, bareHttp: 1, net: 1, fetch: 1, webSocket: 1, renamedCore: 1 });
  });

  it('allows the core type imports, shared modules and errno narrowing, and leaves the adapters, readers and entry alone', async () => {
    expect({
      typeImport: await ruleErrors("import type { SuiteResult } from './testProofResults';\n"),
      typeFromLookup: await ruleErrors("import type { PullRequest } from './pullRequestLookup';\n"),
      shared: await ruleErrors("import { shellQuote } from '../shared/shellQuote';\n"),
      errno: await ruleErrors("import { errMsg } from './errno';\n"),
      adapters: await ruleErrors("import { spawn } from 'node:child_process';\n", 'src/main/testProofPorts.ts'),
      readers: await ruleErrors("import { readFile } from 'node:fs/promises';\n", 'src/main/testProofResults.ts'),
      entry: await ruleErrors('process.exitCode = 1;\n', 'src/main/testProofMain.ts'),
    }).toEqual({ typeImport: 0, typeFromLookup: 0, shared: 0, errno: 0, adapters: 0, readers: 0, entry: 0 });
  });
});
