import { describe, it, expect, afterEach } from 'vitest';
import {
  catalogRefusalReason,
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';

// §18.7.3 / §18.7.6 — a set but unusable active-flow pointer refuses to run: the resolver returns the §18.1
// error load carrying the reason, and runs neither the local flow.yaml nor the global fallback. Every case
// seeds BOTH a valid local flow.yaml and a valid global fallback, so a regression that falls through to either
// turns the load ok and fails.

describe('resolveRunDefinition — an unusable pick refuses to run (§18.7.3, §18.7.6)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => {
    fx.cleanup();
  });

  const seedLocalAndGlobal = (prefix: string): { wt: string; globalRoot: string } => {
    const wt = fx.makeWorktree(prefix);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['local-step'] });
    const globalRoot = fx.makeWorktree(`${prefix}-global`);
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    return { wt, globalRoot };
  };

  const loadError = (load: FlowLoad): string => {
    if (load.ok) throw new Error(`expected a refusal, but "${load.definition.name}" resolved`);
    return load.error;
  };

  const resolveWith = (pointer: PointerRead, miss: CatalogResolution, prefix: string): FlowLoad => {
    const { wt, globalRoot } = seedLocalAndGlobal(prefix);
    return createResolveRunDefinition({ pointer: () => pointer, catalogEntry: () => miss })(wt, globalRoot).load;
  };

  it("a malformed pointer refuses to run and reports the pointer read's own reason", () => {
    const pointerReason = 'active-flow.yaml is malformed [ptr-reason-sentinel]';
    const load = resolveWith({ kind: 'invalid', reason: pointerReason }, { ok: false, cause: 'unknown' }, 'malformed');

    expect(loadError(load)).toContain(pointerReason);
  });

  it.each(['unknown', 'escapes', 'unresolvable'] as const)(
    'a pick whose catalog entry is %s refuses to run and names the picked flow',
    (cause) => {
      const load = resolveWith({ kind: 'value', id: 'my-flow' }, { ok: false, cause }, `pick-${cause}`);

      expect(loadError(load)).toContain('my-flow');
      expect(loadError(load)).not.toMatch(/running the default/i);
      expect(loadError(load)).toMatch(/pick another flow or use the default/i);
    },
  );

  it('the refusal reason reads differently per failure cause', () => {
    const reasons = (['unknown', 'escapes', 'unresolvable'] as const).map((cause) =>
      loadError(resolveWith({ kind: 'value', id: 'my-flow' }, { ok: false, cause }, `distinct-${cause}`)),
    );

    expect(new Set(reasons).size).toBe(3);
  });

  it("the picker's refusal reason for an escaping or unreadable entry is the wording the run refusal uses", () => {
    for (const cause of ['escapes', 'unresolvable'] as const) {
      const load = resolveWith({ kind: 'value', id: 'my-flow' }, { ok: false, cause }, `wording-${cause}`);
      expect(catalogRefusalReason(cause), cause).not.toBe('');
      expect(loadError(load), cause).toContain(catalogRefusalReason(cause));
    }
    expect(catalogRefusalReason('escapes')).not.toBe(catalogRefusalReason('unresolvable'));
  });
});
