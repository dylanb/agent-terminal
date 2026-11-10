import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const THROUGH_HELPER = /tests\/helpers\/controllerCards\.ts/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'tests/unit/controllerProbe.test.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => THROUGH_HELPER.test(m.message)).length;
}

describe('controller tests find cards only through the helper', () => {
  it('flags a hand-written card element, card role or card part test id in a controller test', async () => {
    expect({
      querySelectorArticle: await ruleErrors("host.querySelector('article');\n"),
      querySelectorAllArticle: await ruleErrors("document.querySelectorAll('article');\n"),
      locatorArticle: await ruleErrors("page.locator('main article');\n"),
      closestArticle: await ruleErrors("node.closest('article');\n"),
      roleArticle: await ruleErrors("page.getByRole('article');\n"),
      partTestId: await ruleErrors("card.getByTestId('card-accent');\n"),
    }).toEqual({
      querySelectorArticle: 1,
      querySelectorAllArticle: 1,
      locatorArticle: 1,
      closestArticle: 1,
      roleArticle: 1,
      partTestId: 1,
    });
  });

  it('leaves other elements, and the same code outside controller tests, alone', async () => {
    expect({
      otherButton: await ruleErrors("page.getByRole('button', { name: 'Install the agent-terminal command-line launcher' });\n"),
      header: await ruleErrors("page.locator('#startup-waiting header');\n"),
      articleWord: await ruleErrors("page.locator('.articles');\n"),
      outsideScope: await ruleErrors("host.querySelector('article button');\n", 'tests/unit/monitorPane.test.ts'),
      inHelper: await ruleErrors("root.querySelectorAll('article');\n", 'tests/helpers/controllerCards.ts'),
    }).toEqual({ otherButton: 0, header: 0, articleWord: 0, outsideScope: 0, inHelper: 0 });
  });

  it('the controller tests in the tree follow the rule', async () => {
    const results = await eslint.lintFiles([
      'tests/**/controller*.ts',
      'tests/**/clampedReason.test.ts',
      'tests/**/themeToggle.test.ts',
    ]);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => THROUGH_HELPER.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
