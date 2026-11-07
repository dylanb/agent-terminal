import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

// Drives the project's real eslint.config.mjs, as the pre-commit hook and CI do, so it pins the rule's verdict on
// the source it governs. CODE-STANDARDS.md § Git in a checked-out repository.
const RULE = 'local/git-hardening';
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function hardeningErrors(code: string, filePath = 'src/main/probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => m.ruleId === RULE).length;
}

const IMPORTS =
  "import { run } from './appBootstrapCommand';\n" +
  "import { execFileSync } from 'node:child_process';\n" +
  "import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';\n" +
  "import { bootstrapProtectedArgs } from './appBootstrapGit';\n";

describe('local/git-hardening — a git call leads its argv with the shared overrides', () => {
  it.each([
    ['a literal argv without them', "export const a = (d: string) => run('git', ['status'], d, 'f');\n"],
    ['a passed-through argv', "export const a = (args: string[], d: string) => run('git', args, d, 'f');\n"],
    ['an argv variable without them', "export const a = (d: string) => { const args = ['status']; return run('git', args, d, 'f'); };\n"],
    ['overrides that are not first', "export const a = (d: string) => run('git', ['status', ...coreExecHardeningArgs(freshDisabledHooksDir())], d, 'f');\n"],
    ['a spread of some other array', "export const a = (extra: string[], d: string) => run('git', [...extra, 'status'], d, 'f');\n"],
    ['execFileSync', "export const a = (d: string) => execFileSync('git', ['status'], { cwd: d });\n"],
  ])('flags %s', async (_form, code) => {
    expect(await hardeningErrors(IMPORTS + code)).toBe(1);
  });

  it.each([
    ['coreExecHardeningArgs spread first', "export const a = (d: string) => run('git', [...coreExecHardeningArgs(freshDisabledHooksDir()), 'status'], d, 'f');\n"],
    ['bootstrapProtectedArgs spread first', "export const a = (d: string) => run('git', [...bootstrapProtectedArgs(freshDisabledHooksDir()), 'status'], d, 'f');\n"],
    [
      'a variable holding the overrides',
      "export const a = (args: string[], d: string) => { const hardening = coreExecHardeningArgs(freshDisabledHooksDir()); return run('git', [...hardening, ...args], d, 'f'); };\n",
    ],
    [
      'an argv variable that leads with them',
      "export const a = (d: string) => { const args = [...coreExecHardeningArgs(freshDisabledHooksDir()), 'status']; return run('git', args, d, 'f'); };\n",
    ],
    ['a command other than git', "export const a = (d: string) => run('gh', ['pr', 'view'], d, 'f');\n"],
  ])('passes %s', async (_form, code) => {
    expect(await hardeningErrors(IMPORTS + code)).toBe(0);
  });

  it('governs app code only, not the test kit', async () => {
    expect(await hardeningErrors(IMPORTS + "export const a = (d: string) => run('git', ['status'], d, 'f');\n", 'tests/helpers/probe.ts')).toBe(0);
  });
});
