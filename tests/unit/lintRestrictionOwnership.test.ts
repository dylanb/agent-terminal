import { describe, expect, it } from 'vitest';
import { ESLint, type Linter } from 'eslint';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const RESTRICTION = /(^|\/)no-restricted-/;

async function loadConfig(): Promise<Linter.Config[]> {
  const { default: config } = await import(resolve(root, 'eslint.config.mjs')) as { default: Linter.Config[] };
  return config;
}

function lintedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

describe('a restriction rule with options is set by one config block per file', () => {
  it('names no file two blocks set the same no-restricted-* rule for, since the later block replaces the earlier list', async () => {
    const config = await loadConfig();
    const base = config.filter(block => block.languageOptions || (!block.files && block.ignores));
    const setters = config.flatMap((block, index) =>
      Object.keys(block.rules ?? {}).filter(rule => RESTRICTION.test(rule)).map(rule => ({ rule, index, block })));
    const files = lintedFiles();
    const owners = new Map<string, number[]>();
    for (const { rule, index, block } of setters) {
      const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [...base, block] });
      for (const file of files) {
        const resolved = await eslint.calculateConfigForFile(resolve(root, file)) as Linter.Config | undefined;
        if (!resolved?.rules?.[rule]) continue;
        const key = `${file} ${rule}`;
        owners.set(key, [...(owners.get(key) ?? []), index]);
      }
    }
    expect([...owners].filter(([, blocks]) => blocks.length > 1).map(([key, blocks]) => `${key} (blocks ${blocks.join(', ')})`)).toEqual([]);
  });
});
