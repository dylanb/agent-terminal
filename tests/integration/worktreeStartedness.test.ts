import { describe, it, expect, afterEach } from 'vitest';
import { symlinkSync } from 'node:fs';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { worktreeStartedness } from '../../src/main/startedness';
import { MAX_FLOW_STATE_BYTES } from '../../src/main/flowState';
import { runDispositionFile } from '../../src/main/runDisposition';

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
    // progression must not unlock the gate by making a begun run read back as never-started.
    fx.writeFlowStateRaw(wt, '[unterminated flow sequence');
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for an over-cap progression, never parsing it (§18.7.6/CWE-400)", () => {
    const wt = fx.makeWorktree('a2-startedness-overcap');
    fx.writeFlowStateOversized(wt, MAX_FLOW_STATE_BYTES + 1, { step: 'plan', status: 'not_started' });
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

  it("reports 'indeterminate' (fail-closed) for a present record with a persisted step but an ABSENT status key, never 'never-started' (§18.7.4 case ii / CWE-841)", () => {
    // §18.7.4 case (i) is discriminated by "no persisted step", NOT "no status": a document that HAS a persisted
    // step but is missing its status key is a schema-decode-invalid progression (case ii, `flowState.decode`
    // rejects it identically to `status: error`), so it must fail CLOSED to 'indeterminate'. A truncated write
    // that lost its `status:` line is exactly this class; reading it 'never-started' would let a begun-but-corrupt
    // run take the live source chain mid-run and unlock a new pointer selection — the CWE-841 fail-open the
    // accessor exists to prevent. Sibling of the `status: error` case above, on the status-absent axis.
    const wt = fx.makeWorktree('a2-startedness-step-no-status');
    fx.writeFlowStateRaw(wt, 'step: plan\n');
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for a present record with a begun status but an ABSENT step key, never 'never-started' (§18.7.4 case ii / CWE-841)", () => {
    // Case (i) fail-open is scoped to a genuinely-never-begun doc — absent, or title-only (NEITHER step nor status).
    // A doc that kept a begun `status` but lost its `step` to a truncated write is schema-decode-invalid (case ii,
    // `flowState.decode` rejects it), NOT title-only — §18.7.4 line 167: "the store collapses a document that
    // corrupts AFTER persisting in_progress the same way as one never written." Reading it 'never-started' would
    // unlock a new pointer selection on a begun-but-corrupt run — the CWE-841 fail-open the accessor exists to
    // prevent. Sibling of the step-no-status case above, on the begun-status / step-absent axis.
    const begun = fx.makeWorktree('a2-startedness-status-no-step');
    fx.writeFlowStateRaw(begun, 'status: in_progress\n');
    expect(worktreeStartedness(begun)).toBe('indeterminate');

    const finished = fx.makeWorktree('a2-startedness-done-no-step');
    fx.writeFlowStateRaw(finished, 'status: done\n');
    expect(worktreeStartedness(finished)).toBe('indeterminate');
  });

  it("reports 'indeterminate' (fail-closed) for a present record with an EMPTY step string, never 'never-started' (§18.7.4 case ii / CWE-841)", () => {
    // An empty `step` is schema-decode-invalid exactly as a missing one — `flowState.decode` rejects it on
    // `doc.step.length === 0` — so it is a case (ii) progression that must fail CLOSED to 'indeterminate'. The
    // status is a persistable `not_started`, so step legality is the ONLY thing separating this record from a
    // legitimately never-started one: a classifier that gates on status alone reads it 'never-started' and unlocks
    // a new pointer selection on a begun-but-corrupt run — the CWE-841 fail-open the accessor exists to prevent.
    // This pins the empty-step edge where the accessor's own step-legality guard and flowState.decode's must
    // agree, the drift no type or name catches. Sibling of the step-no-status / status-no-step cases above.
    const wt = fx.makeWorktree('a2-startedness-empty-step');
    fx.writeFlowStateRaw(wt, 'step: ""\nstatus: not_started\n');
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

  it("reports 'indeterminate' (fail-closed) when the run-disposition marker is unverifiable over an otherwise never-started flow-state, never 'never-started' (§18.7.4/CWE-841)", () => {
    // §18.7.4 — the durable disposition marker is consulted before, and overrides, the display status, so an
    // unverifiable marker must fail CLOSED. The flow-state here is a VALID not_started record ('never-started' on
    // its own), so this drives the marker-origin indeterminate branch specifically — distinct from every case
    // above, which fails closed on the flow-state load before the marker is even read. A jail-escaping symlink at
    // the marker leaf makes readDisposition 'indeterminate'; a composition that fell open here would unlock a new
    // selection on a run whose begun-ness cannot be verified — the CWE-841 fail-open the accessor exists to prevent.
    const wt = fx.makeWorktree('a2-startedness-disp-indeterminate');
    fx.writeFlowState(wt, { step: 'plan', status: 'not_started' });
    symlinkSync(fx.outsideDir('a2-startedness-disp-indeterminate-target'), runDispositionFile(wt));
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  it("reports 'indeterminate' for a schema-invalid progression even when the run-disposition marker is present (§18.7.4 case ii)", () => {
    const wt = fx.makeWorktree('a3-startedness-bad-status-marker');
    fx.writeFlowStateRaw(wt, 'step: plan\nstatus: error\n');
    fx.writeRunRecord(wt, { source: 'non-catalog' });
    expect(worktreeStartedness(wt)).toBe('indeterminate');
  });

  // The composed AC7 pins — revertStep and the run record, and the gated write refusal — live in
  // revertStepRunRecord.test.ts and activeFlowGate.test.ts.
});
