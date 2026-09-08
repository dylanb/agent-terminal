import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
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

  // Retained only to DECODE pre-sweep documents (§H.2): no producer writes startedAt now — the cost meter
  // that once stamped it is gone — but a persisted store may still carry it, so the round-trip must hold.
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

  it('round-trips the user title and survives a fresh store', () => {
    createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress', title: 'Refactor the shadow parser' });
    expect(createFlowStateStore(dir).read()).toEqual({
      step: 'plan',
      status: 'in_progress',
      title: 'Refactor the shadow parser',
    });
  });

  it('omits the title key entirely for a flow the user never named', () => {
    createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress' });
    expect(createFlowStateStore(dir).read()).not.toHaveProperty('title');
  });

  it('drops an ill-typed or blank title rather than showing an empty name', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    for (const bad of ['""', '"   "', '42', '[a, b]']) {
      writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), `step: plan\nstatus: in_progress\ntitle: ${bad}\n`);
      expect(createFlowStateStore(dir).read()).toEqual({ step: 'plan', status: 'in_progress' });
    }
  });

  // §28.4 — repeat_counts feeds the loop-back slice cap (CWE-20/770), so the read boundary keeps only
  // positive-integer counts: a negative, non-integer, or non-numeric entry from a hand-edited/corrupt file
  // is dropped rather than trusted as a slice count.
  it('drops an ill-typed or non-positive repeat count on read, keeping only the positive-integer ones', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    const file = join(dir, '.agent-terminal', 'flow-state.yaml');
    writeFileSync(file, 'step: refactor\nstatus: in_progress\nrepeat_counts:\n  refactor: 2\n  neg: -1\n  frac: 2.5\n  word: nope\n');
    const state = createFlowStateStore(dir).read();
    expect(state).toMatchObject({ step: 'refactor', status: 'in_progress', repeatCounts: { refactor: 2 } });
    for (const dropped of ['neg', 'frac', 'word']) expect(state!.repeatCounts).not.toHaveProperty(dropped);
  });

  it('omits repeat_counts entirely when a corrupt map leaves no valid count', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'step: refactor\nstatus: in_progress\nrepeat_counts:\n  refactor: 0\n');
    expect(createFlowStateStore(dir).read()).toEqual({ step: 'refactor', status: 'in_progress' });
  });

  describe('the worktree name, independent of the flow progression', () => {
    it('names a directory that has no progression at all', () => {
      createFlowStateStore(dir).writeTitle('Spike the parser');
      expect(createFlowStateStore(dir).readTitle()).toBe('Spike the parser');
    });

    it('leaves an existing progression untouched when only the name changes', () => {
      const store = createFlowStateStore(dir);
      store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '42' }, startedAt: 1234 });
      store.writeTitle('Refactor the shadow parser');
      expect(createFlowStateStore(dir).read()).toEqual({
        step: 'plan',
        status: 'in_progress',
        inputs: { ticket: '42' },
        startedAt: 1234,
        title: 'Refactor the shadow parser',
      });
    });

    it('refuses to rewrite a progression with unknown fields and leaves it byte-for-byte intact', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      const before = 'step: plan\nstatus: in_progress\nfuture_extension: keep-me\n';
      writeFileSync(file, before);
      expect(() => createFlowStateStore(dir).writeTitle('Named')).toThrow(/unrecognized/i);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('does not re-serialize foreign keys from a readable file', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      const before = 'step: plan\nstatus: in_progress\ngithub_token: ghp_secret_value\noauth_token: xoxb-leak\n';
      writeFileSync(
        file,
        before,
      );
      expect(() => createFlowStateStore(dir).writeTitle('Named')).toThrow(/unrecognized/i);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('write-side strict validation rejects an ill-typed inputs value that the lenient read tolerates', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      writeFileSync(file, 'step: plan\nstatus: in_progress\ninputs:\n  a: ok\n  b: 5\n');
      const store = createFlowStateStore(dir);
      expect(store.read()).toMatchObject({ step: 'plan', status: 'in_progress', inputs: { a: 'ok' } });
      expect(() => store.writeTitle('Named')).toThrow(/unrecognized/i);
      expect(readFileSync(file, 'utf8')).toContain('b: 5'); // strict write left the un-round-trippable doc intact
    });

    it('write-side strict validation rejects an ill-typed repeat_counts that the lenient read tolerates', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      writeFileSync(file, 'step: refactor\nstatus: in_progress\nrepeat_counts:\n  refactor: 0\n');
      const store = createFlowStateStore(dir);
      expect(store.read()).not.toHaveProperty('repeatCounts'); // lenient read drops the non-positive count
      expect(() => store.writeTitle('Named')).toThrow(/unrecognized/i);
      expect(readFileSync(file, 'utf8')).toContain('refactor: 0'); // strict write left the un-round-trippable doc intact
    });

    it('clears the name without disturbing the progression', () => {
      const store = createFlowStateStore(dir);
      store.write({ step: 'plan', status: 'in_progress', title: 'gone' });
      store.writeTitle(null);
      expect(createFlowStateStore(dir).readTitle()).toBeNull();
      expect(createFlowStateStore(dir).read()).toEqual({ step: 'plan', status: 'in_progress' });
    });

    it('reads a name off a file whose progression is corrupt, rather than losing it with the rest', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'step: x\ntitle: Still named\n'); // no status
      expect(createFlowStateStore(dir).read()).toBeNull();
      expect(createFlowStateStore(dir).readTitle()).toBe('Still named');
    });

    it('bounds a repo-supplied name, which is re-parsed on every state query (CWE-400)', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), `step: plan\nstatus: in_progress\ntitle: ${'x'.repeat(10_000)}\n`);
      expect(createFlowStateStore(dir).readTitle()!.length).toBe(200);
    });

    it('refuses to replace malformed YAML when naming the worktree', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      const before = 'status: : : broken\n\t- x';
      writeFileSync(file, before);
      expect(() => createFlowStateStore(dir).writeTitle('Named')).toThrow(/read|parse|unrecognized/i);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('propagates a non-absence read failure and preserves the existing state', () => {
      mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
      const file = join(dir, '.agent-terminal', 'flow-state.yaml');
      const before = 'step: plan\nstatus: in_progress\ninputs:\n  ticket: "42"\n';
      writeFileSync(file, before);
      chmodSync(file, 0o000);
      try {
        expect(() => createFlowStateStore(dir).writeTitle('Named')).toThrow();
      } finally {
        chmodSync(file, 0o600);
      }
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  });

  describe('a write that cannot land must not report success', () => {
    it('throws rather than silently writing nothing when .agent-terminal is a symlink', () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'flow-elsewhere-'));
      symlinkSync(elsewhere, join(dir, '.agent-terminal'));
      expect(() => createFlowStateStore(dir).write({ step: 'plan', status: 'in_progress' })).toThrow();
      expect(() => createFlowStateStore(dir).writeTitle('never lands')).toThrow();
      rmSync(elsewhere, { recursive: true, force: true });
    });
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

  it('reads a __proto__ repeat-count key as own data without prototype pollution (§28.4)', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    // A hand-edited flow-state.yaml whose repeat-count map is keyed by the reserved name.
    writeFileSync(
      join(dir, '.agent-terminal', 'flow-state.yaml'),
      'step: refactor\nstatus: in_progress\nrepeat_counts:\n  __proto__: 3\n  refactor: 2\n',
    );
    const state = createFlowStateStore(dir).read();
    expect(state).not.toBeNull();
    // The reserved key round-trips as own data, not into the prototype setter, and pollutes nothing global.
    expect(Object.prototype.hasOwnProperty.call(state!.repeatCounts, '__proto__')).toBe(true);
    expect(state!.repeatCounts!['__proto__']).toBe(3);
    expect(state!.repeatCounts!.refactor).toBe(2);
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype); // no prototype pollution
  });
});
