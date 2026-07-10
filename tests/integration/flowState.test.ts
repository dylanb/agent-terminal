import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowStateStore } from '../../src/main/flowState';

// §24.2.2 S3 / §19.1 — flow progression persists to <worktree>/.agent-terminal/flow-state.yaml.
// A missing/corrupt file degrades to null (never a throw), mirroring the todoStore (§16.3). The
// store NEVER touches the user's .gitignore (no-gitignore-writes rule). Real store, real temp dirs.

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

  // §26.10 — the instant the flow began, so the cost meter can scope its token sweep to this run rather
  // than to every session ever logged against the repo.
  it('round-trips the instant the flow started', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'plan', status: 'in_progress', startedAt: 1_752_062_400_000 });
    expect(createFlowStateStore(dir).read()).toEqual({ step: 'plan', status: 'in_progress', startedAt: 1_752_062_400_000 });
  });

  it('omits the start instant for a flow that never recorded one', () => {
    createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress' });
    expect(createFlowStateStore(dir).read()).not.toHaveProperty('startedAt');
  });

  it('drops an ill-typed or non-positive start instant rather than reporting an impossible run window', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    for (const bad of ['yesterday', 0, -1, Number.NaN]) {
      writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), `step: plan\nstatus: in_progress\nstarted_at: ${JSON.stringify(bad)}\n`);
      expect(createFlowStateStore(dir).read()).toEqual({ step: 'plan', status: 'in_progress' });
    }
  });

  it('reads null when no flow-state.yaml exists yet (never throws)', () => {
    expect(createFlowStateStore(dir).read()).toBeNull();
  });

  it('does not write through a symlinked .agent-terminal directory (the write cannot escape the worktree) — CWE-59', () => {
    // A cloned repo ships `.agent-terminal` as a symlink to an attacker-chosen directory; the flow
    // write (which may carry resolved inputs) must not land in <target>/flow-state.yaml.
    const outside = mkdtempSync(join(tmpdir(), 'flow-state-outside-'));
    try {
      symlinkSync(outside, join(dir, '.agent-terminal'));
      try {
        createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress' });
      } catch {
        /* refusing the symlinked container may throw; the assertion below is the real check */
      }
      expect(existsSync(join(outside, 'flow-state.yaml'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // §24.2.3 T3 — resolved typed inputs (§18.4) persist alongside progression so they survive a
  // relaunch and thread to later steps (§18.1 output→input). Absent inputs omit the `inputs` key.
  it('round-trips resolved step inputs and survives a fresh store (§24.2.3 T3)', () => {
    createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
    expect(createFlowStateStore(dir).read()).toEqual({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
  });

  it('omits the inputs key entirely when a flow resolved none', () => {
    createFlowStateStore(dir).write({ step: 'groom', status: 'in_progress' });
    expect(createFlowStateStore(dir).read()).toEqual({ step: 'groom', status: 'in_progress' });
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

  it('never creates a .gitignore on write — the app does not modify the user\'s VCS config', () => {
    createFlowStateStore(dir).write({ step: 'groom-ticket', status: 'in_progress' });
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged across writes', () => {
    const before = 'node_modules\n';
    writeFileSync(join(dir, '.gitignore'), before);
    const store = createFlowStateStore(dir);
    store.write({ step: 'groom-ticket', status: 'in_progress' });
    store.write({ step: 'groom-ticket', status: 'done' });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(before);
  });

  it('reads a __proto__ inputs key as own data without prototype pollution', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    // An adversarial / hand-edited flow-state.yaml whose inputs map carries a reserved key.
    writeFileSync(
      join(dir, '.agent-terminal', 'flow-state.yaml'),
      'step: plan\nstatus: in_progress\ninputs:\n  __proto__: PWNED\n  ticket: "5"\n',
    );
    const state = createFlowStateStore(dir).read();
    expect(state).not.toBeNull();
    // The reserved key must round-trip as own data, not vanish into the prototype setter.
    expect(Object.prototype.hasOwnProperty.call(state!.inputs, '__proto__')).toBe(true);
    expect(state!.inputs!['__proto__']).toBe('PWNED');
    expect(state!.inputs!.ticket).toBe('5');
    expect(({} as Record<string, unknown>).PWNED).toBeUndefined(); // no global pollution
  });
});
