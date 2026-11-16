import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const INDEPENDENT = /written independently of the code it checks/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });
const FIXTURE = 'tests/helpers/controllerStatusFixture.ts';

async function ruleErrors(code: string, filePath = FIXTURE): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => INDEPENDENT.test(m.message)).length;
}

describe('an expected-results fixture never imports the code it checks', () => {
  it('flags an import or re-export of production code other than the IPC contract', async () => {
    expect({
      renderer: await ruleErrors("import { cardStatus } from '../../src/renderer/src/controllerCardConditions';\n"),
      shared: await ruleErrors("import { cardStatus } from '../../src/shared/controllerCardClassification';\n"),
      reExport: await ruleErrors("export { cardStatus } from '../../src/shared/controllerCardClassification';\n"),
      inCardHelper: await ruleErrors("import { cardStatus } from '../../src/shared/controllerCardClassification';\n", 'tests/helpers/controllerCards.ts'),
      inProcessTable: await ruleErrors("import { commandsIn } from '../../src/main/waitingRule';\n", 'tests/helpers/processTable.ts'),
      inCardOrderFixture: await ruleErrors("import { cardStatus } from '../../src/shared/controllerCardClassification';\n", 'tests/helpers/controllerCardOrderFixture.ts'),
    }).toEqual({ renderer: 1, shared: 1, reExport: 1, inCardHelper: 1, inProcessTable: 1, inCardOrderFixture: 1 });
  });

  it('allows the IPC contract and other test helpers, and leaves other files alone', async () => {
    expect({
      ipc: await ruleErrors("import type { ControllerTerminal } from '../../src/shared/ipc';\n"),
      ipcDomain: await ruleErrors("import type { ControllerWorkStatus } from '../../src/shared/ipc/controller';\n"),
      helper: await ruleErrors("import { workStatus } from './controllerWorkFixture';\n"),
      otherFile: await ruleErrors("import { cardStatus } from '../../src/shared/controllerCardClassification';\n", 'tests/unit/controllerCardClassification.test.ts'),
    }).toEqual({ ipc: 0, ipcDomain: 0, helper: 0, otherFile: 0 });
  });

  it('the expected-results fixtures in the tree follow the rule', async () => {
    const results = await eslint.lintFiles([FIXTURE, 'tests/helpers/controllerCards.ts', 'tests/helpers/processTable.ts', 'tests/helpers/controllerCardOrderFixture.ts']);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => INDEPENDENT.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
