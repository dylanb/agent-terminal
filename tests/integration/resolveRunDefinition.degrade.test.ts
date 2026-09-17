import { describe, it, expect, afterEach } from 'vitest';
import {
  createResolveRunDefinition,
  type PointerRead,
  type CatalogResolution,
} from '../../src/main/resolveRunDefinition';
import { type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';

// A2 (#133) impl-slice 2 — degrade taxonomy with a visible reason (AC4/AC5). The observable behavior at the
// resolver boundary is twofold and inseparable: a bad pointer (unknown / malformed / over-length / unsafe
// pointer value, or a per-tier confinement escape) must (a) still run the SILENT-fallback definition — never
// crash, never surface an error load — AND (b) carry a `selectionReason` the flow view later renders, so the
// operator sees WHY their selection was ignored. Slice 1 wired only half of this: the resolver falls to the
// fallback on every degrade but returns it SILENTLY (`selectionReason` undefined), which is indistinguishable
// from AC3's legitimate unset default. These pins assert the second half — the visible reason — while keeping
// the first half (the fallback still runs) as the paired assertion, so a "reason but wrong definition" or a
// "right definition but silent" regression each fails.
//
// The pointer() and catalogEntry() SEAMS are injected fakes naming the domain concepts the resolver composes
// (CLAUDE.md injection-seam rule); their real implementations (activeFlowPointer field-validation + byte cap,
// flowCatalog per-tier confine, the strict echo-strip) are covered by their own fixtures as those modules land
// in this slice's GREEN. Here we pin the resolver's own contract: every degrade path yields fallback + reason.

describe('resolveRunDefinition — bad-pointer degrade surfaces a visible reason (§18.7.6 AC4/AC5)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => {
    fx.cleanup();
  });

  // A worktree with `.agent-terminal/` but NO local flow.yaml (so leg 1 never fires) + a distinct global
  // fallback (leg 3) whose definition name is assertable, isolating "did the degrade run the fallback?".
  const seedFallbackOnlyWorktree = (prefix: string): { wt: string; globalRoot: string } => {
    const wt = fx.makeWorktree(prefix);
    const globalRoot = fx.makeWorktree(`${prefix}-global`);
    fx.writeFlowHome(globalRoot, { name: 'global-flow', stepIds: ['global-step'] });
    return { wt, globalRoot };
  };

  const definitionName = (load: FlowLoad): string => {
    if (!load.ok) throw new Error(`expected a resolved definition, got error: ${load.error}`);
    return load.definition.name;
  };

  it('AC4: a `degrade` pointer runs the fallback AND surfaces a non-empty selectionReason (not the silent unset path)', () => {
    const { wt, globalRoot } = seedFallbackOnlyWorktree('degrade-ptr');

    // activeFlowPointer.read() maps a malformed / over-length / over-cap / non-scalar pointer file to a
    // `degrade` with its own reason — a state distinct from `unset` (AC3, no reason) precisely so the operator
    // is told the pointer was rejected. The resolver must carry that reason through, not collapse it to silence.
    // The injected reason is a sentinel no production degrade message would emit, so the only GREEN that can
    // satisfy the toBe below is one that passes THIS pointer's own reason through verbatim — a GREEN that
    // substitutes any single constant reason for every degrade dies here instead of passing on a plausible string.
    const pointerReason = 'active-flow.yaml is malformed [ptr-reason-sentinel::#133]';
    const pointer: () => PointerRead = () => ({ kind: 'degrade', reason: pointerReason });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow'); // never a crash / error load — the fallback runs
    expect(result.selectionReason).toBe(pointerReason); // AC4: the pointer's OWN reason flows through verbatim
  });

  it('AC4: a value pointer naming an UNKNOWN catalog id runs the fallback AND surfaces a reason (silent-drop regression)', () => {
    const { wt, globalRoot } = seedFallbackOnlyWorktree('unknown-id');

    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'ghost' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unknown' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow');
    expect(result.selectionReason).toBeTruthy(); // AC3's unset carries NO reason; an unknown id is a degrade
  });

  it('AC5: a per-tier confinement ESCAPE (cause:"escapes") degrades to the fallback with a reason, never opening the target', () => {
    const { wt, globalRoot } = seedFallbackOnlyWorktree('escape');

    // flowCatalog.resolveCatalogEntry returns cause:'escapes' when a symlink planted at the resolved entry
    // redirects outside the tier jail (confinedRealPathResult). The resolver must degrade with a reason and run
    // the fallback — the escaped target's bytes never become the run (observable here as: the definition is the
    // fallback's, not any catalog id the pointer named).
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'evil' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'escapes' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow'); // the escape target never surfaces as the run
    expect(result.selectionReason).toBeTruthy(); // AC5: the escape degrades VISIBLY
  });

  it('AC4/AC5: an UNRESOLVABLE tier segment (cause:"unresolvable") degrades to the fallback with a reason', () => {
    const { wt, globalRoot } = seedFallbackOnlyWorktree('unresolvable');

    // An unreadable / non-dir / dangling tier segment resolves to cause:'unresolvable' — an unreadable tier is
    // a degrade, never treated as empty (the precedence-inversion guard, §18.7.6), so it too carries a reason.
    const pointer: () => PointerRead = () => ({ kind: 'value', id: 'flaky' });
    const catalogEntry = (): CatalogResolution => ({ ok: false, cause: 'unresolvable' });

    const resolve = createResolveRunDefinition({ pointer, catalogEntry });
    const result = resolve(wt, globalRoot);

    expect(definitionName(result.load)).toBe('global-flow');
    expect(result.selectionReason).toBeTruthy();
  });
});
