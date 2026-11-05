import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const PURE = /engine guide is generated pure and deterministic/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });
const GENERATOR = 'src/main/engineGuide.ts';
const DESCRIPTOR = 'src/shared/engineCapabilities/flow.ts';

async function ruleErrors(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => PURE.test(m.message)).length;
}

describe('the engine guide generator and its descriptor read nothing but their input', () => {
  it('flags the file system, the environment, the clock, randomness and engine modules in the generator', async () => {
    expect({
      fs: await ruleErrors("import { readFileSync } from 'node:fs';\n", GENERATOR),
      os: await ruleErrors("import os from 'os';\n", GENERATOR),
      env: await ruleErrors('export const home = process.env.HOME;\n', GENERATOR),
      clock: await ruleErrors('export const at = Date.now();\n', GENERATOR),
      newDate: await ruleErrors('export const at = new Date();\n', GENERATOR),
      random: await ruleErrors('export const n = Math.random();\n', GENERATOR),
      flowLoader: await ruleErrors("import { MAX_SLICES } from './flow';\n", GENERATOR),
      loopLoader: await ruleErrors("import { WORK_COMPLETIONS } from './loopDefV2';\n", GENERATOR),
      leafFunction: await ruleErrors("import { userConfigLoopsV2Dir } from './userConfig';\n", GENERATOR),
      leafResolver: await ruleErrors("import { resolveLaunchRoot } from './launchRoot';\n", GENERATOR),
      leafNamespace: await ruleErrors("import * as flowHome from './flowHome';\n", GENERATOR),
      cwdPath: await ruleErrors("import path from 'node:path';\nexport const p = path.resolve('example');\n", GENERATOR),
      dirname: await ruleErrors('export const d = __dirname;\n', GENERATOR),
      filename: await ruleErrors('export const f = __filename;\n', GENERATOR),
      importMeta: await ruleErrors('export const u = import.meta.url;\n', GENERATOR),
      namedResolve: await ruleErrors("import { resolve } from 'node:path';\n", GENERATOR),
      mainByParent: await ruleErrors("import { MAX_SLICES } from '../main/flow';\n", GENERATOR),
      leafByParent: await ruleErrors("import { flowHomeDir } from '../main/flowHome';\n", GENERATOR),
      npmPackage: await ruleErrors("import yaml from 'js-yaml';\n", GENERATOR),
      util: await ruleErrors("import { format } from 'node:util';\n", GENERATOR),
      posixResolve: await ruleErrors("import path from 'node:path';\nexport const p = path.posix.resolve('example');\n", GENERATOR),
      dateCall: await ruleErrors('export const at = Date();\n', GENERATOR),
      pathRelative: await ruleErrors("import path from 'node:path';\nexport const p = path.relative('a', 'b');\n", GENERATOR),
    }).toEqual({
      fs: 1, os: 1, env: 1, clock: 1, newDate: 1, random: 1, flowLoader: 1, loopLoader: 1,
      leafFunction: 1, leafResolver: 1, leafNamespace: 1, cwdPath: 1, dirname: 1, filename: 1, importMeta: 1,
      namedResolve: 1, pathRelative: 1, mainByParent: 1, leafByParent: 1, npmPackage: 1, util: 1, posixResolve: 1, dateCall: 1,
    });
  });

  it('flags node built-ins and main-process modules in the descriptor', async () => {
    expect({
      path: await ruleErrors("import path from 'node:path';\n", DESCRIPTOR),
      bareFs: await ruleErrors("import fs from 'fs';\n", DESCRIPTOR),
      barePath: await ruleErrors("import { resolve } from 'path';\n", DESCRIPTOR),
      bareUtil: await ruleErrors("import { format } from 'util';\n", DESCRIPTOR),
      main: await ruleErrors("import { MAX_SLICES } from '../../main/flow';\n", DESCRIPTOR),
      env: await ruleErrors('export const home = process.env.HOME;\n', DESCRIPTOR),
    }).toEqual({ path: 1, bareFs: 1, barePath: 1, bareUtil: 1, main: 1, env: 1 });
  });

  it('allows shared vocabularies and the constant leaves the generator renders, and leaves other files alone', async () => {
    expect({
      shared: await ruleErrors("import { GATE_AUTHORITIES } from '../shared/gateAuthority';\n", GENERATOR),
      leaves: await ruleErrors(
        [
          "import { FLOW_HOME_SUBDIR, FLOW_DEF_FILE, FLOWS_CATALOG_SUBDIR } from './flowHome';",
          "import { APP_HOME_DIR_ENV } from './launchRoot';",
          "import { ARTIFACTS_SUBDIR, LOOP_OVERRIDE_FILE, loopDefRelPath } from './appLoopPaths';",
          "import { LOOPS_V2_SUBDIR, CLAUDE_CONFIG_DIR_ENV, CLAUDE_CONFIG_DEFAULT_SUBDIR } from './userConfig';",
          "import { EXAMPLE_SUBDIR, ENGINE_GUIDE_FILE } from './exampleAssets';",
          "import path from 'node:path';",
          "export const p = path.posix.join('a', 'b');",
        ].join('\n') + '\n',
        GENERATOR,
      ),
      descriptorShared: await ruleErrors("import { GATE_AUTHORITIES } from '../gateAuthority';\n", DESCRIPTOR),
      descriptorSibling: await ruleErrors("import { FLOW_POSITIONS } from './flow';\n", DESCRIPTOR),
      otherMain: await ruleErrors("import { readFileSync } from 'node:fs';\nexport const at = Date.now();\n", 'src/main/flow.ts'),
    }).toEqual({ shared: 0, leaves: 0, descriptorShared: 0, descriptorSibling: 0, otherMain: 0 });
  });
});
