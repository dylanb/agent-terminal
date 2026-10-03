import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { relative, isAbsolute, join } from 'node:path';
import { createFlowStateStore } from '../../src/main/flowState';
import { loadFlowDefinition, flowHomeDir } from '../../src/main/flow';
import { CAN_SYMLINK } from '../helpers/loopArtifacts';
import { createWorktreeFixture } from '../helpers/worktreeFixture';

// The A2 (#133) worktree fixture claims to build the on-disk worktree states the started-ness matrix and the
// three-leg resolver tests drive. This proves each builder against the REAL production readers (createFlowStateStore,
// loadFlowDefinition) — never a mock — so a fixture that drifts from the schema those readers enforce fails here
// rather than silently seeding an input the code under test rejects. Determinism: filesystem-only, fixed bytes.

const isUnder = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
};

describe('worktree fixture — deterministic on-disk states over real production readers', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('makeWorktree creates a worktree root with a real .agent-terminal dir', () => {
    const wt = fx.makeWorktree('wt');
    expect(existsSync(wt)).toBe(true);
    expect(statSync(flowHomeDir(wt)).isDirectory()).toBe(true);
  });

  it('makeFirstRunWorktree omits .agent-terminal so a first-run writer test can prove the tree is created', () => {
    const wt = fx.makeFirstRunWorktree('first-run');
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(flowHomeDir(wt))).toBe(false); // the CLAUDE.md first-run-writer requirement
  });

  it('removeAgentTerminalDir strips an existing .agent-terminal (the AC10 rmSync-first variant)', () => {
    const wt = fx.makeWorktree('ac10');
    expect(existsSync(flowHomeDir(wt))).toBe(true);
    fx.removeAgentTerminalDir(wt);
    expect(existsSync(flowHomeDir(wt))).toBe(false);
  });

  it('writeFlowHome seeds a flow.yaml that loadFlowDefinition accepts with the given name and step ids (leg 1 / leg 3)', () => {
    const wt = fx.makeWorktree('home');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['alpha', 'beta'] });
    const load = loadFlowDefinition(wt);
    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error(load.error);
    expect(load.definition.name).toBe('local-flow');
    expect(load.definition.steps.map((s) => s.id)).toEqual(['alpha', 'beta']);
    expect(load.definition.steps.every((s) => s.kind === 'manual')).toBe(true);
  });

  it('writeFlowState seeds a progression createFlowStateStore.read() decodes to the given step + status', () => {
    const wt = fx.makeWorktree('state');
    fx.writeFlowState(wt, { step: 'green', status: 'in_progress' });
    const state = createFlowStateStore(wt).read();
    expect(state).toEqual({ step: 'green', status: 'in_progress' });
  });

  it('writeFlowStateRaw with a title-only doc reads back as no progression but a readable title', () => {
    const wt = fx.makeWorktree('title-only');
    fx.writeFlowStateRaw(wt, 'title: only a name\n');
    const store = createFlowStateStore(wt);
    expect(store.read()).toBeNull(); // no step/status → not a progression
    expect(store.readTitle()).toBe('only a name');
  });

  it('writeFlowStateRaw with malformed YAML reads back as no progression (the corrupt leg of the matrix)', () => {
    const wt = fx.makeWorktree('corrupt');
    fx.writeFlowStateRaw(wt, 'step: green\n  status: [unterminated\n'); // invalid YAML
    expect(createFlowStateStore(wt).read()).toBeNull();
  });

  it('writeFlowStateRaw writes exactly the bytes given, so callers can plant precise adversarial content', () => {
    const wt = fx.makeWorktree('raw-bytes');
    const contents = 'step: red\nstatus: not_started\n# planted\n';
    const p = fx.writeFlowStateRaw(wt, contents);
    expect(readFileSync(p, 'utf8')).toBe(contents);
  });

  it('writeFlowStateOversized seeds a valid-in-schema record padded past a caller-given byte length', () => {
    const wt = fx.makeWorktree('oversized');
    const min = 8192;
    const p = fx.writeFlowStateOversized(wt, min, { step: 'green', status: 'in_progress' });
    expect(statSync(p).size).toBeGreaterThanOrEqual(min); // exceeds the caller-given length...
    expect(createFlowStateStore(wt).read()).toEqual({ step: 'green', status: 'in_progress' }); // ...yet valid-in-schema
  });

  it.skipIf(!CAN_SYMLINK)(
    'plantFlowStateEscape plants a symlink AT the flow-state path whose target is outside the worktree (CWE-59)',
    () => {
      const wt = fx.makeWorktree('escape');
      const outside = fx.outsideDir('redirect');
      writeFileSync(`${outside}/flow-state.yaml`, 'step: green\nstatus: in_progress\n');
      const p = fx.plantFlowStateEscape(wt, `${outside}/flow-state.yaml`);
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(isUnder(wt, realpathSync(p))).toBe(false); // the resolved target escapes the worktree jail
    },
  );

  it.skipIf(!CAN_SYMLINK)(
    'plantAgentTerminalDirEscape plants .agent-terminal itself as a symlink whose flow-state target escapes the worktree (the intermediate-dir CWE-59 shape a leaf-only lstat misses)',
    () => {
      const wt = fx.makeFirstRunWorktree('parent-escape');
      const outside = fx.outsideDir('parent-redirect');
      writeFileSync(`${outside}/flow-state.yaml`, 'step: green\nstatus: in_progress\n');
      const link = fx.plantAgentTerminalDirEscape(wt, outside);
      expect(lstatSync(link).isSymbolicLink()).toBe(true); // .agent-terminal itself IS the link, not the leaf
      expect(isUnder(wt, realpathSync(join(link, 'flow-state.yaml')))).toBe(false); // its flow-state resolves outside the jail
    },
  );

  it('outsideDir returns a directory outside every worktree the fixture creates', () => {
    const wt = fx.makeWorktree('inside');
    const outside = fx.outsideDir('outside');
    expect(statSync(outside).isDirectory()).toBe(true);
    expect(isUnder(wt, outside)).toBe(false);
  });

  it('cleanup removes every temp dir the fixture created', () => {
    const local = createWorktreeFixture();
    const wt = local.makeWorktree('doomed');
    const outside = local.outsideDir('doomed-outside');
    expect(existsSync(wt)).toBe(true);
    local.cleanup();
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });
});
