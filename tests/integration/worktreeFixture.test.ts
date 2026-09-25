import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { relative, isAbsolute, join } from 'node:path';
import { createFlowStateStore } from '../../src/main/flowState';
import { loadFlowDefinition, flowHomeDir } from '../../src/main/flow';
import { CAN_SYMLINK } from '../helpers/loopArtifacts';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { readDisposition, readRunBinding, runDispositionFile } from '../../src/main/runDisposition';
import { activeFlowPointerFile, readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';

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

// A3 (#134) — the run-record and pointer devices the held-run and picker tests plant. Each device is proven by
// what the PRODUCTION readers make of it (readDisposition / readRunBinding / readActiveFlow / writeActiveFlow),
// so a device that drifts from the shape it claims to plant fails here, not in a slice test's false green.
describe('worktree fixture — run-record and pointer devices (A3 #134)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('writeRunRecord writes a record the production reader reads back as present with the same binding', () => {
    const wt = fx.makeWorktree('a3-record');
    const file = fx.writeRunRecord(wt, { source: 'catalog', tier: 'global', id: 'flow-b' });
    expect(file).toBe(runDispositionFile(wt));
    expect(readDisposition(wt)).toBe('present');
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'flow-b' });
  });

  it('writeRunRecord also seeds a first-run worktree (no .agent-terminal yet)', () => {
    const wt = fx.makeFirstRunWorktree('a3-record-first-run');
    fx.writeRunRecord(wt, { source: 'non-catalog' });
    expect(readRunBinding(wt)).toEqual({ source: 'non-catalog' });
  });

  it('writeRunRecordRaw with garbage reads as a present record whose binding cannot be verified', () => {
    const wt = fx.makeWorktree('a3-record-garbage');
    const contents = 'source: [unterminated\n';
    const file = fx.writeRunRecordRaw(wt, contents);
    expect(readFileSync(file, 'utf8')).toBe(contents);
    expect(readDisposition(wt)).toBe('present');
    expect(readRunBinding(wt)).toBeNull();
  });

  it.skipIf(!CAN_SYMLINK)('plantRunRecordSymlink makes the record unreadable: presence indeterminate, no binding', () => {
    const wt = fx.makeWorktree('a3-record-link');
    const outside = fx.outsideDir('a3-record-link-target');
    const target = join(outside, 'record.yaml');
    writeFileSync(target, 'schema_version: 1\nsource: non-catalog\n');
    fx.writeRunRecord(wt, { source: 'non-catalog' });
    const file = fx.plantRunRecordSymlink(wt, target);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readDisposition(wt)).toBe('indeterminate');
    expect(readRunBinding(wt)).toBeNull();
  });

  it('plantRunRecordDirectory makes the record a non-empty directory: present, no binding', () => {
    const wt = fx.makeWorktree('a3-record-dir');
    fx.writeRunRecord(wt, { source: 'non-catalog' });
    const file = fx.plantRunRecordDirectory(wt);
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(file).length).toBeGreaterThan(0);
    expect(readDisposition(wt)).toBe('present');
    expect(readRunBinding(wt)).toBeNull();
  });

  it('removeRunRecord leaves the record absent, and is a no-op when there is none', () => {
    const wt = fx.makeWorktree('a3-record-missing');
    fx.writeRunRecord(wt, { source: 'non-catalog' });
    fx.removeRunRecord(wt);
    expect(readDisposition(wt)).toBe('absent');
    fx.removeRunRecord(wt);
    expect(readDisposition(wt)).toBe('absent');
  });

  it('plantPointerDirectory replaces a written pointer with a non-empty directory the pointer write cannot replace', () => {
    const wt = fx.makeWorktree('a3-pointer-dir');
    writeActiveFlow(wt, 'flow-a');
    const file = fx.plantPointerDirectory(wt);
    expect(file).toBe(activeFlowPointerFile(wt));
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(file).length).toBeGreaterThan(0);
    expect(readActiveFlow(wt).kind).toBe('invalid');
    expect(() => writeActiveFlow(wt, 'flow-b')).toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it('writePointer plants exactly the given text, which the production reader rejects when it is not a safe id', () => {
    const wt = fx.makeWorktree('a3-pointer-raw');
    const hostile = `"evil\u202e\u200b\u0007${'x'.repeat(100)}"\n`;
    const file = fx.writePointer(wt, hostile);
    expect(file).toBe(activeFlowPointerFile(wt));
    expect(readFileSync(file, 'utf8')).toBe(hostile);
    expect(readActiveFlow(wt).kind).toBe('invalid');
  });

  it('writePointer with a safe id reads back as that selection', () => {
    const wt = fx.makeFirstRunWorktree('a3-pointer-safe');
    fx.writePointer(wt, 'flow-a\n');
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'flow-a' });
  });
});
