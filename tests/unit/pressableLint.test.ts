import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const THROUGH_HELPER = /src\/renderer\/src\/pressable\.ts/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'src/renderer/src/probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => THROUGH_HELPER.test(m.message)).length;
}

describe('renderer controls run their actions only through pressable', () => {
  it('flags a click listener or onclick handler written in renderer code', async () => {
    expect({
      listener: await ruleErrors("button.addEventListener('click', () => save());\n"),
      listenerWithOptions: await ruleErrors("row.addEventListener('click', open, { once: true });\n"),
      templateEventName: await ruleErrors('button.addEventListener(`click`, () => save());\n'),
      property: await ruleErrors('button.onclick = () => save();\n'),
    }).toEqual({ listener: 1, listenerWithOptions: 1, templateEventName: 1, property: 1 });
  });

  it('leaves other events, the helper itself, and code outside the renderer alone', async () => {
    expect({
      keydown: await ruleErrors("input.addEventListener('keydown', onKey);\n"),
      press: await ruleErrors("onPress(button, () => save());\n"),
      inHelper: await ruleErrors("control.addEventListener('click', press);\n", 'src/renderer/src/pressable.ts'),
      mainProcess: await ruleErrors("emitter.addEventListener('click', go);\n", 'src/main/probe.ts'),
      test: await ruleErrors("button.addEventListener('click', go);\n", 'tests/unit/probe.test.ts'),
    }).toEqual({ keydown: 0, press: 0, inHelper: 0, mainProcess: 0, test: 0 });
  });

  it('the renderer source in the tree follows the rule', async () => {
    const results = await eslint.lintFiles(['src/renderer/**/*.ts']);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => THROUGH_HELPER.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
