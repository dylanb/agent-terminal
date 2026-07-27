import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Every tracked `.ts`, split into production sources and everything else. Enumerated through git because
 *  git is the authority for the property under test — whether it classifies the file as text — so a new
 *  root directory or a new root-level config file is covered the moment it is tracked, and an untracked
 *  scratch file is not. */
function trackedSources(): { src: string[]; other: string[] } {
  const files = execFileSync('git', ['ls-files', '-z', '*.ts'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
  return { src: files.filter((f) => f.startsWith('src/')), other: files.filter((f) => !f.startsWith('src/')) };
}

/** The bytes on disk for each tracked path. The worktree is where the property lives: the write-run-commit
 *  order this repo works in stages the file only AFTER the suite has run, so a pin that read the index
 *  could not fail in the window it exists to guard. A tracked path with no file is an ordinary state while
 *  one is being deleted or moved, and is skipped rather than surfacing an ENOENT under this name. */
function worktreeBytes(files: string[]): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>();
  for (const file of files) {
    const full = join(REPO, file);
    if (existsSync(full)) bytes.set(file, readFileSync(full));
  }
  return bytes;
}

function carrying(files: string[], bad: (byte: number) => boolean): string[] {
  const bytes = worktreeBytes(files);
  expect(bytes.size).toBeGreaterThan(0);
  return [...bytes].filter(([, b]) => b.some(bad)).map(([file]) => file);
}

// A raw NUL makes git classify a .ts as BINARY and drop it from every diff, so the file stops being
// reviewable at all. It has landed four times — docs/spec/changelog.md v2.112 and v2.130, the §27 meter's
// window-push key, and a §27 sweep FIXTURE spelling an ill-formed billing identity — each time as a value
// whose control character was embedded rather than escaped, and each time somewhere nobody had thought to
// pin. Every control character is spelled as an escape, or the value is composed some way that needs none.
describe('git keeps every tracked .ts in this repo text', () => {
  it('no production source under src/ carries a raw control byte of any kind', () => {
    expect(carrying(trackedSources().src, (b) => b < 9 || (b > 13 && b < 32))).toEqual([]);
  });

  // Everything outside src/ — tests and the root-level build/test configs — is held to the byte that
  // actually causes the harm rather than to the whole class: a fixture legitimately embeds a control
  // character it exists to exercise (§25.7's strip is driven with a raw BEL), and git keeps such a file
  // text. A NUL is the one that does not.
  it('no other tracked .ts carries a raw NUL', () => {
    expect(carrying(trackedSources().other, (b) => b === 0)).toEqual([]);
  });

  it('watches the roots the repo actually keeps .ts in, not one hand-listed directory', () => {
    const { src, other } = trackedSources();
    expect(src.length).toBeGreaterThan(0);
    expect(other.some((f) => f.startsWith('tests/'))).toBe(true);
    expect(other.some((f) => !f.includes('/'))).toBe(true);
  });

  // The two pins above assert an EMPTY list, so they read identically against a checker that finds nothing
  // and one that reads nothing. This drives the same reader over a byte every source file necessarily
  // carries, so an empty answer above means every enumerated file was opened and was clean — and it names
  // the file it lost if one ever goes unread, rather than reporting `[] not to deeply equal []`.
  it('finds a newline in every file it enumerated, so an empty answer above is not an empty read', () => {
    const { src, other } = trackedSources();
    expect(carrying(src, (b) => b === 0x0a)).toEqual(src);
    expect(carrying(other, (b) => b === 0x0a)).toEqual(other);
  });
});
