import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function carrying(root: string, bad: (byte: number) => boolean): string[] {
  return sourceFiles(join(REPO, root))
    .filter((file) => [...readFileSync(file)].some(bad))
    .map((file) => relative(REPO, file));
}

// A raw NUL makes git classify a .ts as BINARY and drop it from every diff, so the file stops being
// reviewable at all. It has landed four times — docs/spec/changelog.md v2.112 and v2.130, the §27 meter's
// window-push key, and a §27 sweep FIXTURE spelling an ill-formed billing identity — each time as a value
// whose control character was embedded rather than escaped, and each time somewhere nobody had thought to
// pin. Every control character is spelled as an escape, or the value is composed some way that needs none.
describe('git keeps every .ts in this repo text', () => {
  it('no production source carries a raw control byte of any kind', () => {
    expect(carrying('src', (b) => b < 9 || (b > 13 && b < 32))).toEqual([]);
  });

  // Test sources are held to the byte that actually causes the harm rather than to the whole class: a
  // fixture legitimately embeds a control character it exists to exercise (§25.7's strip is driven with a
  // raw BEL), and git keeps such a file text. A NUL is the one that does not.
  it('no test source carries a raw NUL', () => {
    expect(carrying('tests', (b) => b === 0)).toEqual([]);
  });
});
