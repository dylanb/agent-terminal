import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// A single raw control byte makes git classify a .ts as BINARY and drop it from every diff, so the file
// stops being reviewable at all. It has landed three times (docs/spec/changelog.md v2.112 and v2.130, and
// the §27 meter's window-push key), each time as a composite key whose separator was embedded rather than
// escaped. Held over the whole tree rather than per-file, because the next one will be in a module nobody
// thought to pin: every separator is spelled as an escape, or the value is composed some way that needs none.
it('no source file carries a raw control byte, so git keeps every one of them text', () => {
  const binary = sourceFiles(SRC).filter((file) =>
    [...readFileSync(file)].some((b) => b < 9 || (b > 13 && b < 32)),
  );
  expect(binary.map((f) => f.slice(SRC.length + 1))).toEqual([]);
});
