import { describe, it, expect, afterEach } from 'vitest';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { worktreeStartedness } from '../../src/main/startedness';

// A2 (#133) §18.7.4 AC7 — worktreeStartedness is the semantic started-ness accessor the pointer-write gate,
// definition resolution, and A3's picker-enable read (the "raw durable started-ness" contract). It classifies a
// worktree's REAL on-disk progression into the shared StartednessSignal (createWorktreeFixture, no mocks):
//   * a begun run (in_progress) -> 'started'      (AC7 "refused once the run has begun")
//   * a worktree that never wrote a progression -> 'never-started'  (AC7 "permitted only while never started")
//   * a present-but-unverifiable progression -> 'indeterminate'  (AC7 fail-closed; never 'never-started')
// The progression is seeded through the fixture's own writers (flow-state.yaml), never a hand-composed literal.
describe('worktreeStartedness — the durable run started-ness accessor (§18.7.4 AC7)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it("reports 'started' for a begun (in_progress) progression", () => {
    const wt = fx.makeWorktree('a2-startedness-begun');
    fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });
    expect(worktreeStartedness(wt)).toBe('started');
  });

  it("reports 'started' for a completed (done) progression — a begun run is in_progress OR done (§18.7.4 case iii)", () => {
    const wt = fx.makeWorktree('a2-startedness-done');
    fx.writeFlowState(wt, { step: 'plan', status: 'done' });
    expect(worktreeStartedness(wt)).toBe('started');
  });

  it("reports 'never-started' for a worktree with no progression at all", () => {
    const wt = fx.makeFirstRunWorktree('a2-startedness-fresh');
    expect(worktreeStartedness(wt)).toBe('never-started');
  });

  // §18.7.4 AC7 "permitted only while never started" — the accessor has THREE never-started legs (absent, above;
  // a present-but-not-begun record; a title-only doc), and only 'started'/'indeterminate' lock a selection. The
  // flow-state store returns null for a title-only valid-YAML doc AND for an unparseable one alike
  // (worktreeFixture.test.ts), so these two pins plus the unparseable→'indeterminate' RED below jointly forbid a
  // classifier that keys on read()===null alone: fail-closed on the unverifiable case must NOT extend to locking
  // a legitimately never-started worktree.
  it("reports 'never-started' for a present but never-begun (not_started) progression record", () => {
    const wt = fx.makeWorktree('a2-startedness-not-begun');
    fx.writeFlowState(wt, { step: 'plan', status: 'not_started' });
    expect(worktreeStartedness(wt)).toBe('never-started');
  });

  it("reports 'never-started' for a present title-only doc (valid YAML, no progression), never 'indeterminate'", () => {
    const wt = fx.makeWorktree('a2-startedness-title-only');
    fx.writeFlowStateRaw(wt, 'title: only a name\n');
    expect(worktreeStartedness(wt)).toBe('never-started');
  });

  it("reports 'indeterminate' (fail-closed) for a present but unparseable progression, never 'never-started'", () => {
    const wt = fx.makeWorktree('a2-startedness-corrupt');
    // §18.7.4 / CWE-841 — a present-but-unverifiable flow-state must fail CLOSED: an attacker who corrupts the
    // progression must not unlock the gate by making a begun run read back as never-started. A byte-cap variant
    // (over-cap valid record -> 'indeterminate') is authored RED-first in GREEN alongside flowState's bounded
    // reader, since that cap constant is a GREEN deliverable; this cap-independent parse-failure case pins the
    // fail-closed classification now.
    fx.writeFlowStateRaw(wt, '[unterminated flow sequence');
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for a present record whose status is outside the persistable vocabulary, never 'never-started' (§18.7.4/CWE-841)", () => {
    // A valid YAML mapping whose `status` the store's own decode rejects is a schema-invalid progression, and
    // §18.7.4 AC7 ("refused while begun-ness is indeterminate — a corrupt … progression") makes it fail CLOSED
    // exactly like an unparseable one. `status: error` is a FlowStatus the persistability gate excludes (a
    // truncated write such as `status: in_progre` is the same class); reading it 'never-started' would let a
    // begun-but-corrupt run take the live source chain mid-run and unlock a new pointer selection — the CWE-841
    // fail-open the accessor exists to prevent. This also pins co-parser agreement: worktreeStartedness and
    // flowState.decode gate legality on the one shared persistable-status predicate, so neither can silently
    // treat a status the other rejects as a different category.
    const wt = fx.makeWorktree('a2-startedness-bad-status');
    fx.writeFlowStateRaw(wt, 'step: plan\nstatus: error\n');
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for a worktree whose root does not resolve, never 'never-started' (§18.7.4/CWE-841)", () => {
    // §18.7.4 — begun-ness is read through the confined flow-state path, which jails the leaf under the
    // worktree's `.agent-terminal`. When the worktree ROOT itself does not resolve (resolveJail → null) the
    // progression cannot be verified at all, so it must fail CLOSED exactly like the unparseable and
    // escaping-leaf cases; a reader that treated an unresolvable anchor as absent would fall OPEN to
    // 'never-started' and unlock a new selection (CWE-841). Distinct code path from the planted-symlink escape
    // below — that one fails confinement AFTER the anchor resolves — so neither test subsumes the other.
    const wt = fx.nonexistentWorktree('a2-startedness-absent-anchor');
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for a flow-state path that escapes the worktree jail, never 'never-started' (§18.7.4/CWE-59)", () => {
    // §18.7.4 — the flow-state path is confined before the accessor reads it; a repo-planted symlink at it must
    // not redirect this safety-gate read. The redirect target is a REAL, valid not_started record outside the
    // jail, so an UNCONFINED reader would trust it and answer 'never-started' (the fail-open bug), while the
    // confined reader detects the escape and fails CLOSED to 'indeterminate'.
    const decoy = fx.makeWorktree('a2-startedness-escape-decoy');
    const decoyState = fx.writeFlowState(decoy, { step: 'plan', status: 'not_started' });
    const wt = fx.makeWorktree('a2-startedness-escape');
    fx.plantFlowStateEscape(wt, decoyState);
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  // Deferred within this RED turn (declared, not silent — the slice-1 red-result pattern): two impl-slice-3
  // acceptance-level REDs are authored RED-first WITHIN the write-gate GREEN, each blocked on a GREEN deliverable
  // that must exist first for the RED to fail by an assertion rather than a missing-symbol error:
  //   * §18.7.4 AC7 revertStep-stays-locked — a not_started record carrying the durable has-started marker reads
  //     'started', and a real first-step `revertStep` then the real `flow:setActiveFlow` handler is refused with
  //     `active-flow.yaml` byte-for-byte unchanged. Blocked on `recordDisposition` (the run-disposition own-file
  //     whose presence IS the marker; its on-disk representation is a GREEN decision) and the gated handler. This
  //     is the branch a naive `status !== 'not_started'` classifier slips through (CWE-841).
  //   * §18.7.4 AC7 composed write-gate refusal — `flow:setActiveFlow` refused under 'started'/'indeterminate',
  //     permitted only under 'never-started', serialized under the cross-process worktree lock. Blocked on the
  //     gated handler and `worktreeLock.ts`. `worktreeStartedness` and `isSelectionLocked` are pinned in isolation
  //     here; composing them at the write boundary is glue that gets its own RED in GREEN ("glue is code").
});
