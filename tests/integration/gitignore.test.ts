import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGitignored } from '../../src/main/gitignore';

// Append-once .gitignore management shared by the per-directory app-owned state stores
// (flow-state.yaml §19.1, audit-pointer.yaml §25, monitor-events.json §8.4). Must preserve a
// user's existing .gitignore content and never duplicate the entry. Real fs, real temp dirs.

describe('ensureGitignored', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitignore-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = () => readFileSync(join(dir, '.gitignore'), 'utf8');

  it('creates .gitignore with the entry when none exists', () => {
    ensureGitignored(dir, '.agent-terminal/monitor-events.json');
    expect(read()).toBe('.agent-terminal/monitor-events.json\n');
  });

  it('preserves existing content and appends the entry (inserting a newline when missing)', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist'); // no trailing newline
    ensureGitignored(dir, '.agent-terminal/monitor-events.json');
    expect(read()).toBe('node_modules\ndist\n.agent-terminal/monitor-events.json\n');
  });

  it('is idempotent — a second call does not duplicate the entry', () => {
    ensureGitignored(dir, '.agent-terminal/monitor-events.json');
    ensureGitignored(dir, '.agent-terminal/monitor-events.json');
    const lines = read().split('\n').filter((l) => l.trim() === '.agent-terminal/monitor-events.json');
    expect(lines).toHaveLength(1);
  });

  it('does not re-add an entry the user already listed', () => {
    writeFileSync(join(dir, '.gitignore'), '.agent-terminal/monitor-events.json\n');
    ensureGitignored(dir, '.agent-terminal/monitor-events.json');
    expect(read()).toBe('.agent-terminal/monitor-events.json\n');
  });
});
