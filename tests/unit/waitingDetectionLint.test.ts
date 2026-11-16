import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const SEAM_ONLY = /Waiting detection core decides from its seam values only/;
const NEVER_BLOCKS = /Waiting detection never blocks the main process/;
const PLATFORM_PARAMETER = /Waiting detection takes the platform as a parameter/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
const RULE = 'src/main/waitingRule.ts';
const DETECTOR = 'src/main/waitingDetector.ts';
const LOOKUP = 'src/main/waitingLookup.ts';
const HELPER_FILE = 'src/main/waitingHelperFile.ts';

async function errorsMatching(pattern: RegExp, code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => pattern.test(m.message)).length;
}

describe('the Waiting detection core decides from its seam values only', () => {
  const core = (code: string, filePath = RULE) => errorsMatching(SEAM_ONLY, code, filePath);

  it('flags process, filesystem and clock access, and value imports of the modules behind its seams', async () => {
    expect({
      childProcess: await core("import { execFile } from 'node:child_process';\n"),
      fs: await core("import { readFileSync } from 'node:fs';\n"),
      platform: await core("export const mac = process.platform === 'darwin';\n"),
      timer: await core('export const arm = (cb: () => void) => setTimeout(cb, 1000);\n', DETECTOR),
      interval: await core('export const tick = (cb: () => void) => setInterval(cb, 1000);\n', DETECTOR),
      wallClock: await core('export const now = () => Date.now();\n', DETECTOR),
      monotonic: await core('export const now = () => performance.now();\n', DETECTOR),
      globalThisClock: await core('export const now = () => globalThis.Date.now();\n', DETECTOR),
      timersModule: await core("import { setTimeout } from 'node:timers';\n", DETECTOR),
      timersPromises: await core("import { setTimeout as delay } from 'timers/promises';\n", DETECTOR),
      perfHooks: await core("import { performance } from 'node:perf_hooks';\n", DETECTOR),
      lookup: await core("import { lookUpProcesses } from './waitingLookup';\n", DETECTOR),
      helperFile: await core("import { readHelperNames } from './waitingHelperFile';\n", DETECTOR),
      runtimeConfig: await core("import { resolveRuntimeConfig } from './runtimeConfig';\n", DETECTOR),
      require: await core("export const cp = require('node:child_process');\n"),
      dynamicImport: await core("export const load = () => import('./waitingLookup');\n", DETECTOR),
    }).toEqual({
      childProcess: 1, fs: 1, platform: 1, timer: 1, interval: 1, wallClock: 1, monotonic: 1, globalThisClock: 1, timersModule: 1, timersPromises: 1, perfHooks: 1,
      lookup: 1, helperFile: 1, runtimeConfig: 1, require: 1, dynamicImport: 1,
    });
  });

  it('allows type imports of its seams, the other core modules, errno and shared modules', async () => {
    expect({
      lookupType: await core("import type { ProcessTable } from './waitingLookup';\n", DETECTOR),
      coreSibling: await core("import { commandsIn } from './waitingRule';\n", DETECTOR),
      errno: await core("import { errMsg } from './errno';\n", DETECTOR),
      shared: await core("import { waitingLabel } from '../shared/waiting';\n"),
      lookupModule: await core("import { execFile } from 'node:child_process';\n", LOOKUP),
      helperFileModule: await core("import { readFile } from 'node:fs/promises';\n", HELPER_FILE),
    }).toEqual({ lookupType: 0, coreSibling: 0, errno: 0, shared: 0, lookupModule: 0, helperFileModule: 0 });
  });
});

describe('Waiting detection never blocks the main process', () => {
  const blocking = (code: string, filePath = LOOKUP) => errorsMatching(NEVER_BLOCKS, code, filePath);

  it('flags synchronous child_process calls and real-time bounds in the lookup and the helper-file reader', async () => {
    expect({
      execFileSync: await blocking("import { execFileSync } from 'node:child_process';\n"),
      spawnSync: await blocking("import { spawnSync } from 'child_process';\n"),
      execSync: await blocking("import { execSync } from 'node:child_process';\n"),
      inHelperFile: await blocking("import { execFileSync } from 'node:child_process';\n", HELPER_FILE),
      defaultImport: await blocking("import cp from 'node:child_process';\nexport const out = () => cp.execFileSync('ps');\n"),
      require: await blocking("const { execFileSync } = require('node:child_process');\nexport const out = () => execFileSync('ps');\n"),
      dynamicImport: await blocking("export const out = async () => (await import('node:child_process')).execFileSync('ps');\n", HELPER_FILE),
      timeoutOption: await blocking("import { execFile } from 'node:child_process';\nexport const run = (cb: () => void) => execFile('ps', [], { timeout: 1000 }, cb);\n"),
      promisified: await blocking("import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nexport const out = () => run('ps', [], { timeout: 1000 });\n"),
      aliased: await blocking("import { execFile as run } from 'node:child_process';\nexport const out = (cb: () => void) => run('ps', [], { timeout: 1000 }, cb);\n"),
      optionsVariable: await blocking("import { execFile } from 'node:child_process';\nconst options = { timeout: 1000 };\nexport const out = (cb: () => void) => execFile('ps', [], options, cb);\n"),
      abortSignalTimeout: await blocking("import { execFile } from 'node:child_process';\nexport const out = (cb: () => void) => execFile('ps', [], { signal: AbortSignal.timeout(1000) }, cb);\n"),
      abortSignalTimeoutInCore: await blocking('export const bound = () => AbortSignal.timeout(1000);\n', DETECTOR),
      globalThisTimer: await blocking('export const bound = (abort: () => void) => globalThis.setTimeout(abort, 1000);\n'),
      ownTimer: await blocking('export const bound = (abort: () => void) => setTimeout(abort, 1000);\n'),
      timersModule: await blocking("import { setTimeout as delay } from 'node:timers/promises';\n", HELPER_FILE),
    }).toEqual({
      execFileSync: 1, spawnSync: 1, execSync: 1, inHelperFile: 1, defaultImport: 1, require: 1, dynamicImport: 1,
      timeoutOption: 1, promisified: 1, aliased: 1, optionsVariable: 1, abortSignalTimeout: 1, abortSignalTimeoutInCore: 1, globalThisTimer: 1, ownTimer: 1, timersModule: 1,
    });
  });

  it('allows the asynchronous calls, and leaves the rest of src/main alone', async () => {
    expect({
      execFile: await blocking("import { execFile } from 'node:child_process';\n"),
      spawn: await blocking("import { spawn } from 'child_process';\n"),
      signalOption: await blocking("import { execFile } from 'node:child_process';\nexport const run = (signal: AbortSignal, cb: () => void) => execFile('ps', [], { signal }, cb);\n"),
      otherModule: await blocking("import { execFileSync } from 'node:child_process';\n", 'src/main/foregroundCommand.ts'),
    }).toEqual({ execFile: 0, spawn: 0, signalOption: 0, otherModule: 0 });
  });
});

describe('Waiting detection takes the platform as a parameter', () => {
  const platformRead = (code: string, filePath = LOOKUP) => errorsMatching(PLATFORM_PARAMETER, code, filePath);

  it('flags a platform read in the lookup, the helper-file reader and the core', async () => {
    expect({
      processPlatform: await platformRead("export const mac = process.platform === 'darwin';\n"),
      osPlatform: await platformRead("import os from 'node:os';\nexport const mac = os.platform() === 'darwin';\n"),
      importedPlatform: await platformRead("import { platform } from 'node:os';\nexport const mac = platform() === 'darwin';\n"),
      inHelperFile: await platformRead('export const p = process.platform;\n', HELPER_FILE),
      inCore: await platformRead('export const p = process.platform;\n', RULE),
    }).toEqual({ processPlatform: 1, osPlatform: 1, importedPlatform: 1, inHelperFile: 1, inCore: 1 });
  });

  it('allows the platform as a parameter, and leaves the composition root alone', async () => {
    expect({
      parameter: await platformRead("export const mac = (platform: NodeJS.Platform) => platform === 'darwin';\n"),
      compositionRoot: await platformRead('export const p = process.platform;\n', 'src/main/index.ts'),
    }).toEqual({ parameter: 0, compositionRoot: 0 });
  });
});

it('the Waiting detection modules in the tree follow every rule', async () => {
  const results = await eslint.lintFiles(['src/main/waiting*.ts']);
  const offenders = results.flatMap((r) =>
    r.messages.filter((m) => [SEAM_ONLY, NEVER_BLOCKS, PLATFORM_PARAMETER].some((rule) => rule.test(m.message))).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
  );
  expect(offenders).toEqual([]);
});
