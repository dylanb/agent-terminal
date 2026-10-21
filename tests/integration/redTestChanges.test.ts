import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRedTestChanges, recordRedTestChanges, redTestChangesArtifact } from '../../src/main/redTestChanges';
import { MAX_CHANGED_TEST_PATHS } from '../../src/main/appLoopState';

// §28.5.1 (v2.210) — the record of every RED test a later step changed, kept for the whole branch so the
// implementation approval can list each one. Real temp files, no fs mocks.

describe('the RED test change record', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'red-test-changes-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const file = (): string => redTestChangesArtifact(repo);

  it('is created on first run, with the app state root absent, and read back', () => {
    rmSync(join(repo, '.agent-terminal'), { recursive: true, force: true });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    expect(readRedTestChanges(repo)).toEqual({ branch: 'feat', changes: [{ step: 'green', slice: 1, paths: ['tests/a.test.ts'] }] });
  });

  it('keeps each step and slice, in slice order, and a step recorded again for its slice replaces its earlier entry', () => {
    recordRedTestChanges(repo, { branch: 'feat', step: 'refactor', slice: 2, paths: ['tests/b.test.ts'] });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 2, paths: ['tests/c.test.ts'] });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/d.test.ts'] });
    expect(readRedTestChanges(repo)?.changes).toEqual([
      { step: 'green', slice: 1, paths: ['tests/d.test.ts'] },
      { step: 'refactor', slice: 2, paths: ['tests/b.test.ts'] },
      { step: 'green', slice: 2, paths: ['tests/c.test.ts'] },
    ]);
  });

  it('a check that found no change removes that step\'s entry and leaves the record saying nothing changed', () => {
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: [] });
    expect(readRedTestChanges(repo)).toEqual({ branch: 'feat', changes: [] });
  });

  it('a record from another branch is replaced, never added to', () => {
    recordRedTestChanges(repo, { branch: 'old-ticket', step: 'green', slice: 3, paths: ['tests/old.test.ts'] });
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    expect(readRedTestChanges(repo)).toEqual({ branch: 'feat', changes: [{ step: 'green', slice: 1, paths: ['tests/a.test.ts'] }] });
  });

  it('a malformed record is replaced by the next write rather than failing it', () => {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), 'changes: [not, a, record\n');
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    expect(readRedTestChanges(repo)?.changes).toEqual([{ step: 'green', slice: 1, paths: ['tests/a.test.ts'] }]);
  });

  it('reads an absent or malformed record as none, and drops entries that are not well formed', () => {
    expect(readRedTestChanges(repo)).toBeNull();
    mkdirSync(dirname(file()), { recursive: true });
    for (const bad of ['- a list\n', 'schema_version: 1\nbranch: ""\nchanges: []\n', 'schema_version: 9\nbranch: feat\nchanges: []\n', 'schema_version: 1\nbranch: feat\nchanges: nope\n']) {
      writeFileSync(file(), bad);
      expect(readRedTestChanges(repo), bad).toBeNull();
    }
    writeFileSync(
      file(),
      'schema_version: 1\nbranch: feat\nchanges:\n  - { step: green, slice: 1, paths: [tests/a.test.ts, "", 7] }\n  - { step: "", slice: 1, paths: [x] }\n  - { step: green, slice: 0, paths: [x] }\n  - { step: green, slice: 2, paths: [] }\n',
    );
    expect(readRedTestChanges(repo)).toEqual({ branch: 'feat', changes: [{ step: 'green', slice: 1, paths: ['tests/a.test.ts'] }] });
  });

  it('records at most the changed-test path cap per entry', () => {
    const many = Array.from({ length: MAX_CHANGED_TEST_PATHS + 5 }, (_, i) => `tests/f${String(i).padStart(6, '0')}.test.ts`);
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: many });
    expect(readRedTestChanges(repo)?.changes[0].paths).toHaveLength(MAX_CHANGED_TEST_PATHS);
  });

  it('creates no .gitignore and leaves an existing one byte-for-byte unchanged', () => {
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 1, paths: ['tests/a.test.ts'] });
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    recordRedTestChanges(repo, { branch: 'feat', step: 'green', slice: 2, paths: ['tests/b.test.ts'] });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });
});
