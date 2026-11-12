import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { RAIL_RUN_TOTAL_TEST_ID, RAIL_STEP_LIST_NAME, TOKEN_COUNT_TEST_ID, TOKEN_TABLE_NAME } from '../helpers/tokenCountsUi';

const THROUGH_HELPER = /tests\/helpers\/tokenCountsUi\.ts/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'tests/unit/flowStrip.test.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => THROUGH_HELPER.test(m.message)).length;
}

describe('token-count tests read the screen only through the helper', () => {
  it('flags a test that spells a count part, the table name or the step list name itself', async () => {
    expect({
      countTestId: await ruleErrors(`station.getByTestId('${TOKEN_COUNT_TEST_ID}');\n`),
      runTotalTestId: await ruleErrors(`page.getByTestId('${RAIL_RUN_TOTAL_TEST_ID}');\n`),
      countSelector: await ruleErrors(`host.querySelector('[data-testid="${TOKEN_COUNT_TEST_ID}"]');\n`),
      templateSelector: await ruleErrors(`host.querySelectorAll(\`[data-testid="${RAIL_RUN_TOTAL_TEST_ID}"] span\`);\n`),
      tableName: await ruleErrors(`page.getByRole('table', { name: '${TOKEN_TABLE_NAME}' });\n`),
      stepListName: await ruleErrors(`page.getByRole('list', { name: '${RAIL_STEP_LIST_NAME}' });\n`),
      inE2e: await ruleErrors(`page.getByTestId('${TOKEN_COUNT_TEST_ID}');\n`, 'tests/e2e/tokenCounts.spec.ts'),
      inBrowser: await ruleErrors(`page.getByRole('table', { name: '${TOKEN_TABLE_NAME}' });\n`, 'tests/browser/loopPanel.test.ts'),
    }).toEqual({ countTestId: 1, runTotalTestId: 1, countSelector: 1, templateSelector: 1, tableName: 1, stepListName: 1, inE2e: 1, inBrowser: 1 });
  });

  it('leaves the helper, other names and production code alone', async () => {
    expect({
      inHelper: await ruleErrors("scope.getByTestId('token-count');\n", 'tests/helpers/tokenCountsUi.ts'),
      otherTestId: await ruleErrors("page.getByTestId('token-counts-off');\n"),
      otherTable: await ruleErrors("page.getByRole('table', { name: 'Reviewers' });\n"),
      inRenderer: await ruleErrors("count.dataset.testid = 'token-count';\n", 'src/renderer/src/tokenCount.ts'),
    }).toEqual({ inHelper: 0, otherTestId: 0, otherTable: 0, inRenderer: 0 });
  });

  it('keeps the controller tests on their own card rule', async () => {
    const [result] = await eslint.lintText("page.getByRole('article');\n", { filePath: resolve(root, 'tests/e2e/controllerCards.spec.ts') });
    expect(result.messages.filter((m) => /tests\/helpers\/controllerCards\.ts/.test(m.message))).toHaveLength(1);
  });
});
