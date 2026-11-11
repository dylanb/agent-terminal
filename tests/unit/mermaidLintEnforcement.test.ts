import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('the Mermaid diagram check is actually enforced', () => {
  it('the lint script, which the pre-commit hook and the pull-request CI run, parses every Markdown diagram', () => {
    expect(pkg.scripts?.lint).toMatch(/(^|&&\s*)node\s+scripts\/lint-mermaid\.mjs(\s|$)/);
  });
});
