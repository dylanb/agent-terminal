import { describe, it, expect, afterEach } from 'vitest';
import {
  catalogRefusalReason,
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { MAX_FLOW_DEFINITION_BYTES, type FlowLoad } from '../../src/main/flow';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  const resolveEntry = (prefix: string, plant: (flowYaml: string) => void): FlowLoad => {
    const { wt, globalRoot } = seedLocalAndGlobal(prefix);
    const entryDir = join(wt, 'catalog-entry');
    mkdirSync(entryDir, { recursive: true });
    plant(join(entryDir, 'flow.yaml'));
    return createResolveRunDefinition({
      pointer: () => ({ kind: 'value', id: 'my-flow' }),
      catalogEntry: () => ({ ok: true, tier: 'repo', flowDir: entryDir }),
    })(wt, globalRoot).load;
  };

  it("a picked entry whose flow.yaml is a symlink refuses to run, never loading the link's target (CWE-59)", () => {
    const outside = fx.makeWorktree('entry-symlink-target');
    fx.writeFlowHome(outside, { name: 'outside-flow', stepIds: ['outside-step'] });

    const load = resolveEntry('entry-symlink', (flowYaml) => symlinkSync(join(outside, '.agent-terminal', 'flow.yaml'), flowYaml));

    expect(loadError(load)).toMatch(/flow\.yaml/);
  });

  it('a picked entry whose flow.yaml is larger than the definition cap refuses to run (CWE-400)', () => {
    const load = resolveEntry('entry-oversize', (flowYaml) =>
      writeFileSync(flowYaml, `name: big\nsteps:\n  - id: s1\n    kind: manual\n# ${'x'.repeat(MAX_FLOW_DEFINITION_BYTES)}\n`),
    );

    expect(loadError(load)).toMatch(/larger than/);
  });

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
