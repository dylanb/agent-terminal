import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowManager } from '../../src/main/flow';

// The flow follows the terminal's cwd, mirroring the repo-scoped todo logic (§16.3): the flow
// manager is keyed by repoKey (a git root, or a plain dir), each key owning its own definition
// (local-first-then-global, §18.1) and its own flow-state.yaml (§19.1). State for one repo never
// leaks into another — the bug this fixes. Tests drive real temp dirs (no fs mocks); the
// observable contract is the per-key state view + cross-key independence + persistence per key.

const VALID = (name: string): string => `name: ${name}\nsteps:\n  - id: ${name}-step\n    kind: manual\n`;

describe('flow manager (repo-keyed, follows cwd)', () => {
  let a: string;
  let b: string;
  let home: string;
  const seed = (dir: string, name: string): void => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), VALID(name));
  };
  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), 'flow-mgr-a-'));
    b = mkdtempSync(join(tmpdir(), 'flow-mgr-b-'));
    home = mkdtempSync(join(tmpdir(), 'flow-mgr-home-'));
    seed(a, 'alpha');
    seed(b, 'beta');
  });
  afterEach(() => {
    for (const d of [a, b, home]) rmSync(d, { recursive: true, force: true });
  });

  it('reports each repo key its own definition', () => {
    const mgr = createFlowManager({ globalDir: home });
    expect(mgr.state(a).stepName).toBe('alpha-step');
    expect(mgr.state(b).stepName).toBe('beta-step');
  });

  it('keeps progression independent per repo key (the cwd-switch bug)', () => {
    const mgr = createFlowManager({ globalDir: home });
    mgr.start(a); // repo A → in_progress
    // Switching to repo B must NOT inherit A's progression.
    expect(mgr.state(b).status).toBe('not_started');
    // ...and A is unchanged when we come back.
    expect(mgr.state(a).status).toBe('in_progress');
  });

  it('persists progression per key so a fresh manager resumes each independently', () => {
    createFlowManager({ globalDir: home }).start(a);
    const fresh = createFlowManager({ globalDir: home });
    expect(fresh.state(a).status).toBe('in_progress');
    expect(fresh.state(b).status).toBe('not_started');
  });

  it('creates no .agent-terminal directory merely from reading state (only writes do, on a transition)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'flow-mgr-readonly-'));
    try {
      const mgr = createFlowManager({ globalDir: home });
      mgr.state(plain); // visiting a repo by cd-ing must not litter it with an empty dir
      expect(existsSync(join(plain, '.agent-terminal'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('runs onEnterStep with the step on a start, surfacing its notice (skill injection §18.6/§19.3)', () => {
    const onEnterStep = vi.fn(() => ({ notice: 'agent is busy' }));
    const mgr = createFlowManager({ globalDir: home, onEnterStep });
    const view = mgr.start(a);
    // §24.2.3 T3: entry actions now receive (step, resolvedInputs); a fresh flow has resolved none.
    expect(onEnterStep).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha-step', kind: 'manual' }), {});
    expect(view.notice).toBe('agent is busy');
    // Reading state afterwards never re-fires entry actions nor carries the one-shot notice.
    expect(mgr.state(a).notice).toBeUndefined();
  });

  // The DEFINITION (flow.yaml) is re-read on every access, not cached at first visit — so a file
  // added, edited, or removed while the app runs is picked up on the next directory entry (§18.1).
  // This mirrors the §19.1 state re-read; the cached error from an absent file no longer sticks.
  it('picks up a flow.yaml added after the first visit (re-reads the definition on re-entry)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'flow-mgr-added-'));
    try {
      const mgr = createFlowManager({ globalDir: home });
      expect(mgr.state(plain).status).toBe('error'); // no flow.yaml yet
      seed(plain, 'late'); // the file appears while the app is running
      expect(mgr.state(plain).status).not.toBe('error');
      expect(mgr.state(plain).stepName).toBe('late-step');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reflects an edited flow.yaml, replacing the previously-loaded definition', () => {
    const mgr = createFlowManager({ globalDir: home });
    expect(mgr.state(a).stepName).toBe('alpha-step');
    writeFileSync(join(a, '.agent-terminal', 'flow.yaml'), VALID('revised')); // edited on disk
    expect(mgr.state(a).stepName).toBe('revised-step');
  });

  it('reflects a removed flow.yaml, dropping back to the no-definition error state', () => {
    const mgr = createFlowManager({ globalDir: home });
    expect(mgr.state(a).status).toBe('not_started');
    rmSync(join(a, '.agent-terminal', 'flow.yaml'));
    expect(mgr.state(a).status).toBe('error');
  });

  it('falls back to the global definition for a repo with no local flow.yaml, state still per-key', () => {
    seed(home, 'global');
    const plain = mkdtempSync(join(tmpdir(), 'flow-mgr-plain-'));
    try {
      const mgr = createFlowManager({ globalDir: home });
      expect(mgr.state(plain).stepName).toBe('global-step'); // definition from global
      mgr.start(plain);
      // State is the plain dir's own — it does not touch the global dir's progression.
      expect(createFlowManager({ globalDir: home }).state(plain).status).toBe('in_progress');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
