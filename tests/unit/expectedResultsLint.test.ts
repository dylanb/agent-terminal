import { beforeAll, describe, expect, it } from 'vitest';
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
  beforeAll(() => ruleErrors(''));

  it.each([
    ['an import from the renderer', "import { cardStatus } from '../../src/renderer/src/controllerCardConditions';\n", FIXTURE],
    ['an import from shared code', "import { cardStatus } from '../../src/shared/controllerCardClassification';\n", FIXTURE],
    ['a re-export of shared code', "export { cardStatus } from '../../src/shared/controllerCardClassification';\n", FIXTURE],
    ['an import in the card helper', "import { cardStatus } from '../../src/shared/controllerCardClassification';\n", 'tests/helpers/controllerCards.ts'],
    ['an import in the process table', "import { commandsIn } from '../../src/main/waitingRule';\n", 'tests/helpers/processTable.ts'],
    ['an import in the card order fixture', "import { cardStatus } from '../../src/shared/controllerCardClassification';\n", 'tests/helpers/controllerCardOrderFixture.ts'],
    ['an import in the token helper', "import type { TokenKind } from '../../src/shared/tokenCounts';\n", 'tests/helpers/tokenCountsUi.ts'],
    ['an import in the token format fixture', "import { abbreviatedTokens } from '../../src/renderer/src/tokenFormat';\n", 'tests/helpers/tokenFormatFixture.ts'],
  ])('flags %s, production code other than the IPC contract', async (_case, code, filePath) => {
    expect(await ruleErrors(code, filePath)).toBe(1);
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
    const results = await eslint.lintFiles([
      FIXTURE,
      'tests/helpers/controllerCards.ts',
      'tests/helpers/processTable.ts',
      'tests/helpers/controllerCardOrderFixture.ts',
      'tests/helpers/tokenCountsUi.ts',
      'tests/helpers/tokenFormatFixture.ts',
    ]);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => INDEPENDENT.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
