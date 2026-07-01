import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHumanNote } from '../../src/main/humanNotes';

// §26.6 — a gate's `append-human-note` action writes the human's reason into
// `.agent-loop/human-notes/{iter}.md`, which the next work-agent turn's recipe injects (request-changes
// feedback, §19.4). App-owned persistence: it creates no .gitignore (CLAUDE.md).
describe('writeHumanNote (§26.6 human-notes)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'humannote-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('writes the note to .agent-loop/human-notes/{iter}.md', () => {
    writeHumanNote(repo, 2, 'make the plan smaller');
    const file = join(repo, '.agent-loop', 'human-notes', '2.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('make the plan smaller');
  });

  it('appends a second note to the same iteration file rather than overwriting', () => {
    writeHumanNote(repo, 3, 'first note');
    writeHumanNote(repo, 3, 'second note');
    const body = readFileSync(join(repo, '.agent-loop', 'human-notes', '3.md'), 'utf8');
    expect(body).toContain('first note');
    expect(body).toContain('second note');
  });

  it('creates NO .gitignore (CLAUDE.md: the app never edits the user VCS config)', () => {
    writeHumanNote(repo, 1, 'note');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged', () => {
    const gi = join(repo, '.gitignore');
    writeFileSync(gi, 'node_modules\n');
    writeHumanNote(repo, 1, 'note');
    expect(readFileSync(gi, 'utf8')).toBe('node_modules\n');
  });
});
