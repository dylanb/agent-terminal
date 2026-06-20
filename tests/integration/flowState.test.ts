import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowStateStore } from '../../src/main/flowState';
import type { FlowStatus } from '../../src/shared/ipc';

// §24.2.2 S3 / §19.1 — flow progression persists to <worktree>/.agent-terminal/flow-state.yaml.
// Tests drive the real store against real temp dirs (no fs mocks): the observable contract is
// what round-trips through read()/write() and what lands in the worktree's .gitignore. A
// missing/corrupt file degrades to null (never a throw), mirroring the todoStore (§16.3).

const GITIGNORE_ENTRY = '.agent-terminal/flow-state.yaml';

describe('flow-state store (§24.2.2 S3 / §19.1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the current step and its status through write/read', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'groom-ticket', status: 'in_progress' });
    expect(store.read()).toEqual({ step: 'groom-ticket', status: 'in_progress' });
  });

  it('persists across a fresh store on the same worktree (simulates relaunch)', () => {
    createFlowStateStore(dir).write({ step: 'groom-ticket', status: 'done' });
    expect(createFlowStateStore(dir).read()).toEqual({ step: 'groom-ticket', status: 'done' });
  });

  it('reads null when no flow-state.yaml exists yet (never throws)', () => {
    expect(createFlowStateStore(dir).read()).toBeNull();
  });

  it('reads null on a corrupt/unparseable file rather than throwing', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'status: : : broken\n\t- x');
    expect(createFlowStateStore(dir).read()).toBeNull();
  });

  it('reads null when the file parses but is missing required fields', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'step: x\n'); // no status
    expect(createFlowStateStore(dir).read()).toBeNull();
  });

  it('gitignores flow-state.yaml on first write (§19.1)', () => {
    createFlowStateStore(dir).write({ step: 'groom-ticket', status: 'in_progress' });
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toContain(GITIGNORE_ENTRY);
  });

  it('does not duplicate the ignore entry across repeated writes', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'groom-ticket', status: 'in_progress' });
    store.write({ step: 'groom-ticket', status: 'done' });
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines.filter((l) => l === GITIGNORE_ENTRY)).toHaveLength(1);
  });

  it('preserves an existing .gitignore and only appends the new entry', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    createFlowStateStore(dir).write({ step: 'groom-ticket', status: 'in_progress' });
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('node_modules');
    expect(lines).toContain(GITIGNORE_ENTRY);
  });

  it('does not re-add the entry when the user already ignores it', () => {
    writeFileSync(join(dir, '.gitignore'), `${GITIGNORE_ENTRY}\n`);
    createFlowStateStore(dir).write({ step: 'groom-ticket', status: 'done' });
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines.filter((l) => l === GITIGNORE_ENTRY)).toHaveLength(1);
  });

  it('does not persist a non-persistable status (error), keeping the last good state readable', () => {
    // read() only accepts not_started/in_progress/done; writing `error` would create a file read()
    // can never parse back. write() must reject it so the last good progression survives.
    const store = createFlowStateStore(dir);
    store.write({ step: 'groom-ticket', status: 'in_progress' });
    store.write({ step: 'groom-ticket', status: 'error' as FlowStatus });
    expect(store.read()).toEqual({ step: 'groom-ticket', status: 'in_progress' });
  });

  it('fails open when .gitignore is not writable — state still persists, no throw (§19.1)', () => {
    // gitignore is best-effort; the state write already succeeded. A non-writable .gitignore
    // (here a directory in its place → EISDIR) must not take down the transition.
    mkdirSync(join(dir, '.gitignore'), { recursive: true });
    const store = createFlowStateStore(dir);
    expect(() => store.write({ step: 'groom-ticket', status: 'in_progress' })).not.toThrow();
    expect(store.read()).toEqual({ step: 'groom-ticket', status: 'in_progress' });
  });
});
