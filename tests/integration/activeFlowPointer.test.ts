import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import {
  activeFlowPointerFile,
  clearActiveFlow,
  readActiveFlow,
  writeActiveFlow,
} from '../../src/main/activeFlowPointer';

// A2 (#133) slice-5 — the per-worktree active-flow pointer's own disjoint file (§18.7.2). These drive the
// production writer/reader over REAL on-disk worktree states (createWorktreeFixture, no mocks) and assert the
// observable file/round-trip outcomes, never the write mechanism:
//   * AC10 — a first write on a worktree with no .agent-terminal creates the full path, reads back the id, and
//     writes no .gitignore (leaving a pre-existing one byte-for-byte unchanged).
//   * AC8  — a pointer write persists WITHOUT touching the disjoint progression file flow-state.yaml.
// The pointer file location is taken from the store's own resolver (activeFlowPointerFile), the same
// writer↔reader single-source the code under test writes through — never a hand-composed literal.

describe('activeFlowPointer — first-run persistence & non-clobber (§18.7.2 AC10/AC8)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  // TODO(#133 slice-5 GREEN): the confined write/read must REFUSE a pointer path reached through an escaping
  // `.agent-terminal` symlink (resolveJail + confinedRealPath, mirroring appLoopState.ts — CWE-22/59). It is
  // pinned RED in GREEN with fx.plantAgentTerminalDirEscape: the assertion needs the real write, so against
  // this no-op stub it passes vacuously — an inauthentic RED — and belongs where the confinement wiring lands.

  it('AC10: a first write on a worktree with no .agent-terminal creates the full path, reads back the id, and writes no .gitignore', () => {
    const wt = fx.makeFirstRunWorktree('a2-pointer-firstrun');
    // A pre-existing .gitignore must be left byte-for-byte unchanged (the no-.gitignore-writes rule): the
    // atomic write touches only the pointer file it is given.
    const gitignore = join(wt, '.gitignore');
    const gitignoreBytes = Buffer.from('node_modules/\ndist/\n');
    writeFileSync(gitignore, gitignoreBytes);

    writeActiveFlow(wt, 'feature-dev');

    // The write creates the full .agent-terminal path down to the pointer's own file (AC10 first-run-absent-root).
    expect(existsSync(activeFlowPointerFile(wt))).toBe(true);
    // …and the operator's selection reads back through the store's public read path.
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
    // …and the pre-existing .gitignore is untouched, byte-for-byte (no-.gitignore-writes rule).
    expect(readFileSync(gitignore)).toEqual(gitignoreBytes);
  });

  it('AC8: a pointer write persists the id without touching the disjoint progression file', () => {
    const wt = fx.makeWorktree('a2-pointer-nonclobber');
    // Seed a real progression at flow-state.yaml — the disjoint file a pointer write must never clobber.
    const stateFile = fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });
    const progressionBefore = readFileSync(stateFile);

    writeActiveFlow(wt, 'feature-dev');

    // The pointer write took effect (persisted + reads back the id)…
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
    // …while leaving the disjoint progression file byte-for-byte unchanged (§18.7.2 own-file; AC8).
    expect(readFileSync(stateFile)).toEqual(progressionBefore);
  });

  it('AC10: a first write on a worktree with no pre-existing .gitignore creates none', () => {
    const wt = fx.makeFirstRunWorktree('a2-pointer-firstrun-nogitignore');

    writeActiveFlow(wt, 'feature-dev');

    // The write took effect (first-run create) — the precondition that fails RED against the no-op stub.
    expect(existsSync(activeFlowPointerFile(wt))).toBe(true);
    // …and it seeded NO .gitignore — neither inside the app-state dir it creates nor at the worktree root.
    // The prior AC10 case pins "leaves a pre-existing one unchanged"; this pins the "creates none" half the
    // no-.gitignore-writes rule also requires (the appLoopState.ts / flowState.ts reference pins do both).
    const appStateDir = dirname(activeFlowPointerFile(wt));
    expect(existsSync(join(appStateDir, '.gitignore'))).toBe(false);
    expect(existsSync(join(wt, '.gitignore'))).toBe(false);
  });

  it('AC8: clearing the pointer returns it to unset and leaves the disjoint progression file unchanged', () => {
    const wt = fx.makeWorktree('a2-pointer-clear');
    const stateFile = fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });
    const progressionBefore = readFileSync(stateFile);

    writeActiveFlow(wt, 'feature-dev');
    // The write took effect — the precondition that fails RED against the no-op stub.
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });

    clearActiveFlow(wt);
    // Clearing returns the worktree to the unset default…
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
    // …while leaving the disjoint progression file byte-for-byte unchanged (§18.7.2 own-file; AC8 clear leg).
    expect(readFileSync(stateFile)).toEqual(progressionBefore);
  });
});

describe('activeFlowPointer — readActiveFlow field-validates the pointer value (§18.7.6 degrade taxonomy)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  // readActiveFlow IS the resolver's leg-2 pointer() producer. resolveRunDefinition.degrade.test.ts pins the
  // resolver's carry-through of a `degrade` through an injected FAKE pointer() and defers the REAL parser's
  // value validation "to their own fixtures as those modules land in this slice's GREEN" — these are those
  // fixtures. A malformed / non-scalar / over-length / unsafe pointer value must read back as
  // { kind: 'degrade' } — a state distinct from the unset default (AC3) so the resolver surfaces a reason —
  // gated by src/shared/pathSegment.ts's safe-catalog-ID contract. Adversarial values are planted off the
  // store's OWN path resolver (activeFlowPointerFile), the same writer↔reader single-source; no second
  // serializer lives here.
  //
  // TODO(#133 slice-5 GREEN): the byte-cap (over-cap → degrade) and non-ENOENT-errno (→ total) read-boundary
  // branches are pinned in GREEN's own boundary fixtures, where the byte-cap constant and a permission seam
  // exist; they are not provokable against the no-op stub without inventing that unchosen threshold.

  const plantPointer = (wt: string, contents: string): void => {
    const file = activeFlowPointerFile(wt);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  // stub → { kind: 'unset' }, so `.kind` fails RED for the intended reason. Each degrade case must also carry
  // a non-empty reason (AC4 "visible reason"): the resolver passes pointer.reason through verbatim
  // (resolveRunDefinition.ts:73), so a GREEN returning reason:'' would run the fallback with nothing surfaced.
  const expectDegradeWithReason = (wt: string): void => {
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('degrade');
    if (read.kind === 'degrade') expect(read.reason).toBeTruthy();
  };

  it('degrades a malformed (unparseable) pointer value', () => {
    const wt = fx.makeWorktree('a2-pointer-malformed');
    plantPointer(wt, '[unterminated flow sequence');
    expectDegradeWithReason(wt);
  });

  it('degrades a non-scalar pointer value (a mapping, not a single id)', () => {
    const wt = fx.makeWorktree('a2-pointer-nonscalar');
    plantPointer(wt, 'step: plan\nstatus: in_progress\n');
    expectDegradeWithReason(wt);
  });

  it('degrades an over-length pointer value (beyond the shared catalog-ID bound)', () => {
    const wt = fx.makeWorktree('a2-pointer-overlength');
    plantPointer(wt, 'a'.repeat(MAX_CATALOG_ID_LENGTH + 1));
    expectDegradeWithReason(wt);
  });

  it('degrades an unsafe pointer value (fails the safe-path-segment charset)', () => {
    const wt = fx.makeWorktree('a2-pointer-unsafe');
    plantPointer(wt, '../../etc/passwd');
    expectDegradeWithReason(wt);
  });
});
