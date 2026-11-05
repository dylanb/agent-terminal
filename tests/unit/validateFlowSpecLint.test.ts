import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const THROUGH_HARNESS = /tests\/e2e\/installedRuntime\.ts/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'tests/e2e/validateFlow.spec.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => THROUGH_HARNESS.test(m.message)).length;
}

describe('the installed-runtime e2e specs run every process through the harness', () => {
  it('flags a hand-spawned process, the operator environment and a fixed sleep in each such spec', async () => {
    const cases = {
      childProcess: "import { spawnSync } from 'node:child_process';\n",
      bareChildProcess: "import { execFile } from 'child_process';\n",
      envRead: 'const home = process.env.HOME;\n',
      envSpread: 'const env = { ...process.env };\n',
      envImport: "import { env } from 'node:process';\n",
      bareEnvImport: "import { env } from 'process';\n",
      registeredElectron: "import { electron } from './registeredElectron';\n",
      playwrightElectron: "import { _electron } from '@playwright/test';\n",
      waitForTimeout: 'await page.waitForTimeout(500);\n',
      promiseSleep: 'await new Promise((r) => setTimeout(r, 500));\n',
      timersSleep: "import { setTimeout } from 'node:timers/promises';\n",
    };
    const flagged = async (file: string) =>
      Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([k, code]) => [k, await ruleErrors(code, file)])));
    const once = Object.fromEntries(Object.keys(cases).map((k) => [k, 1]));
    expect(await flagged('tests/e2e/validateFlow.spec.ts')).toEqual(once);
    expect(await flagged('tests/e2e/validateFlowInstall.spec.ts')).toEqual(once);
    expect(await flagged('tests/e2e/finalizeInstalledAccess.spec.ts')).toEqual(once);
  });

  it('leaves the harness modules, the harness calls and other specs alone', async () => {
    const handRolled = "import { spawn } from 'node:child_process';\nconst e = { ...process.env };\n";
    expect({
      harnessCall: await ruleErrors("const r = await rt.validate([dir], { cwd });\nexpectPass(r);\n"),
      runtime: await ruleErrors(handRolled, 'tests/e2e/installedRuntime.ts'),
      harness: await ruleErrors(handRolled, 'tests/e2e/validateFlowHarness.ts'),
      launcher: await ruleErrors(handRolled, 'tests/e2e/installedLauncher.ts'),
      otherSpec: await ruleErrors(handRolled, 'tests/e2e/app.spec.ts'),
    }).toEqual({ harnessCall: 0, runtime: 0, harness: 0, launcher: 0, otherSpec: 0 });
  });
});
