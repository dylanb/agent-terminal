import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const THROUGH_ONE_OF = /src\/shared\/oneOf\.ts/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'src/main/probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => THROUGH_ONE_OF.test(m.message)).length;
}

describe('membership in a closed list is checked only through isOneOf', () => {
  it('flags a hand-written includes against a list constant or a cast list', async () => {
    expect({
      castList: await ruleErrors('const ok = (KINDS as readonly string[]).includes(v);\n'),
      castLowercaseList: await ruleErrors('const ok = (kinds as readonly unknown[]).includes(v);\n'),
      castValue: await ruleErrors('const ok = KINDS.includes(v as Kind);\n'),
      bareConstant: await ruleErrors('const ok = RETIRED_IDS.includes(name);\n'),
    }).toEqual({ castList: 1, castLowercaseList: 1, castValue: 1, bareConstant: 1 });
  });

  it('flags it in source files that carry other restricted-syntax rules', async () => {
    const code = 'const ok = (KINDS as readonly string[]).includes(v);\n';
    expect({
      renderer: await ruleErrors(code, 'src/renderer/src/probe.ts'),
      engineGuide: await ruleErrors(code, 'src/main/engineGuide.ts'),
      descriptor: await ruleErrors(code, 'src/shared/engineCapabilities/probe.ts'),
    }).toEqual({ renderer: 1, engineGuide: 1, descriptor: 1 });
  });

  it('leaves isOneOf, includes on an ordinary value, the guard itself and test code alone', async () => {
    expect({
      guardCall: await ruleErrors('const ok = isOneOf(KINDS, v);\n'),
      stringIncludes: await ruleErrors("const ok = name.includes('-');\n"),
      localArray: await ruleErrors('const ok = seen.includes(id);\n'),
      inGuard: await ruleErrors('const ok = (values as readonly unknown[]).includes(value);\n', 'src/shared/oneOf.ts'),
      test: await ruleErrors('const ok = (KINDS as readonly string[]).includes(v);\n', 'tests/unit/probe.test.ts'),
    }).toEqual({ guardCall: 0, stringIncludes: 0, localArray: 0, inGuard: 0, test: 0 });
  });

  it('the source in the tree follows the rule', async () => {
    const results = await eslint.lintFiles(['src/**/*.ts']);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => THROUGH_ONE_OF.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
