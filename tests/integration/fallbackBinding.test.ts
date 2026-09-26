import { afterEach, describe, expect, it } from 'vitest';
import { flowCatalogDir, flowDefinitionFile, flowHomeDir, resumesAt, type FlowDefinition, type FlowLoad } from '../../src/main/flow';
import { createBoundSourceLoader, createRunResolver } from '../../src/main/runResolver';
import type { DispositionRead } from '../../src/main/resolveRunDefinition';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { readRunBinding, recordDisposition } from '../../src/main/runDisposition';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';

// A3 (#134) §18.7.3 T7 / AC15 — a run recovered onto the global fallback is bound to that one file: it keeps
// loading it across a relaunch even after the pointer is rewritten and a local flow.yaml is added.

type BoundSourceLoader = (worktree: string, binding: DispositionRead) => FlowLoad;

const boundSourceLoader = (globalDir: string): BoundSourceLoader => createBoundSourceLoader(globalDir);

const stepIds = (load: FlowLoad): string[] | string =>
  load.ok ? load.definition.steps.map((s) => s.id) : `<error: ${load.error}>`;

describe('the fallback run disposition (§18.7.3 T7)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  it('a fallback binding round-trips through the production record/read pair', () => {
    const wt = fx.makeWorktree('a3-fb-roundtrip');

    recordDisposition(wt, { source: 'fallback' } as DispositionRead);

    expect(readRunBinding(wt)).toEqual({ source: 'fallback' });
  });

  it('AC15: a fallback-bound begun run keeps loading the global fallback after the pointer is rewritten and a local flow.yaml is added', () => {
    const home = fx.makeWorktree('a3-fb-home');
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['g1', 'g2'] });
    catalog.addEntryWithSteps(flowCatalogDir(home), 'other', ['o1', 'o2']);
    const wt = fx.makeWorktree('a3-fb-wt');
    fx.writeFlowState(wt, { step: 'g2', status: 'in_progress' });
    recordDisposition(wt, { source: 'fallback' } as DispositionRead);

    writeActiveFlow(wt, 'other');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l1', 'l2'] });
    const relaunched = createRunResolver(home)(wt);

    expect(stepIds(relaunched.load)).toEqual(['g1', 'g2']);
    expect(relaunched.binding).toEqual({ source: 'fallback' });
  });

  it('AC15 (pinning): a catalog-bound begun run keeps loading its entry after the pointer is rewritten and a local flow.yaml is added', () => {
    const home = fx.makeWorktree('a3-cat-home');
    catalog.addEntryWithSteps(flowCatalogDir(home), 'picked', ['p1', 'p2']);
    catalog.addEntryWithSteps(flowCatalogDir(home), 'other', ['o1', 'o2']);
    const wt = fx.makeWorktree('a3-cat-wt');
    fx.writeFlowState(wt, { step: 'p2', status: 'in_progress' });
    recordDisposition(wt, { source: 'catalog', tier: 'global', id: 'picked' });

    writeActiveFlow(wt, 'other');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l1', 'l2'] });

    expect(stepIds(createRunResolver(home)(wt).load)).toEqual(['p1', 'p2']);
  });

  it('the fallback loads the file hasFlowDefinition and the relaunch read, derived from one resolver', () => {
    const home = fx.makeWorktree('a3-fb-file-home');
    const written = fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['g1'] });

    expect(written).toBe(flowDefinitionFile(home));
    const load = boundSourceLoader(home)(fx.makeWorktree('a3-fb-file-wt'), { source: 'fallback' } as DispositionRead);
    expect(load.ok && load.flowDir).toBe(flowHomeDir(home));
  });
});

describe('createBoundSourceLoader — the definition a recorded binding loads (§18.7.3)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  function rig() {
    const home = fx.makeWorktree('a3-bsl-home');
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['g1', 'g2'] });
    catalog.addEntryWithSteps(flowCatalogDir(home), 'x', ['gx1', 'gx2']);
    const wt = fx.makeWorktree('a3-bsl-wt');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l1', 'l2'] });
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'x', ['rx1', 'rx2']);
    return { home, wt, load: boundSourceLoader(home) };
  }

  it('a global catalog binding loads the global entry even when a repo entry of the same id shadows it', () => {
    const { wt, load } = rig();
    expect(stepIds(load(wt, { source: 'catalog', tier: 'global', id: 'x' }))).toEqual(['gx1', 'gx2']);
  });

  it('a repo catalog binding loads the repo entry', () => {
    const { wt, load } = rig();
    expect(stepIds(load(wt, { source: 'catalog', tier: 'repo', id: 'x' }))).toEqual(['rx1', 'rx2']);
  });

  it('a non-catalog binding loads the local flow.yaml', () => {
    const { wt, load } = rig();
    expect(stepIds(load(wt, { source: 'non-catalog' }))).toEqual(['l1', 'l2']);
  });

  it('a fallback binding loads the global fallback, never the local flow.yaml', () => {
    const { wt, load } = rig();
    expect(stepIds(load(wt, { source: 'fallback' } as DispositionRead))).toEqual(['g1', 'g2']);
  });
});

describe('resumesAt — whether a definition continues at a persisted step (§19.1)', () => {
  const def: FlowDefinition = {
    name: 'f',
    steps: [
      { id: 's1', kind: 'manual' },
      { id: 's2', kind: 'manual' },
    ] as FlowDefinition['steps'],
  };

  it('is true for a step the definition contains', () => {
    expect(resumesAt(def, 's2')).toBe(true);
  });

  it('is false for a step the definition lacks', () => {
    expect(resumesAt(def, 's9')).toBe(false);
  });
});
