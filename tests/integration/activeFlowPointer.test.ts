import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import { createFlowManager } from '../../src/main/flow';
import { createActiveFlowGate } from '../../src/main/activeFlowGate';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import {
  ACTIVE_FLOW_FILE,
  activeFlowPointerFile,
  clearActiveFlow,
  MAX_POINTER_FILE_BYTES,
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

  it('clearActiveFlow does not throw when a non-file sits at the pointer path (best-effort contract)', () => {
    const wt = fx.makeWorktree('a2-pointer-clear-nonfile');
    // A directory planted at the pointer path makes rmSync throw EISDIR — `force` covers only ENOENT and does
    // not recurse. clearActiveFlow's documented best-effort contract ("never crash") requires this swallowed.
    mkdirSync(activeFlowPointerFile(wt), { recursive: true });
    expect(() => clearActiveFlow(wt)).not.toThrow();
  });

  it('AC8: a progression write leaves the pointer file byte-for-byte unchanged (reverse non-clobber)', () => {
    const wt = fx.makeWorktree('a2-pointer-reverse-nonclobber');
    writeActiveFlow(wt, 'feature-dev');
    const pointerBefore = readFileSync(activeFlowPointerFile(wt));

    // §18.7.2 own-file: the pointer is disjoint from flow-state.yaml, so a progression write cannot touch it.
    fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });

    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(pointerBefore);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
  });
});

describe('activeFlowPointer — readActiveFlow field-validates the pointer value (§18.7.6)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  // readActiveFlow IS the resolver's pointer() producer. resolveRunDefinition.refusal.test.ts pins the
  // resolver's refusal on an `invalid` through an injected FAKE pointer() and defers the REAL parser's
  // value validation "to their own fixtures as those modules land in this slice's GREEN" — these are those
  // fixtures. A malformed / non-scalar / over-length / unsafe pointer value must read back as
  // { kind: 'invalid' } — a state distinct from the unset default (AC3) so the resolver surfaces a reason —
  // gated by src/shared/pathSegment.ts's safe-catalog-ID contract. Adversarial values are planted off the
  // store's OWN path resolver (activeFlowPointerFile), the same writer↔reader single-source; no second
  // serializer lives here.

  const plantPointer = (wt: string, contents: string): void => {
    const file = activeFlowPointerFile(wt);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  // stub → { kind: 'unset' }, so `.kind` fails RED for the intended reason. Each invalid case must also carry
  // a non-empty reason (AC4 "visible reason"): the resolver passes pointer.reason through verbatim
  // (resolveRunDefinition.ts), so a GREEN returning reason:'' would refuse the run with nothing surfaced.
  const expectInvalidWithReason = (wt: string): void => {
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('invalid');
    if (read.kind === 'invalid') expect(read.reason).toBeTruthy();
  };

  it('rejects a malformed (unparseable) pointer value', () => {
    const wt = fx.makeWorktree('a2-pointer-malformed');
    plantPointer(wt, '[unterminated flow sequence');
    expectInvalidWithReason(wt);
  });

  it('rejects a non-scalar pointer value (a mapping, not a single id)', () => {
    const wt = fx.makeWorktree('a2-pointer-nonscalar');
    plantPointer(wt, 'step: plan\nstatus: in_progress\n');
    expectInvalidWithReason(wt);
  });

  it('rejects an over-length pointer value (beyond the shared catalog-ID bound)', () => {
    const wt = fx.makeWorktree('a2-pointer-overlength');
    plantPointer(wt, 'a'.repeat(MAX_CATALOG_ID_LENGTH + 1));
    expectInvalidWithReason(wt);
  });

  it('rejects an unsafe pointer value (fails the safe-path-segment charset)', () => {
    const wt = fx.makeWorktree('a2-pointer-unsafe');
    plantPointer(wt, '../../etc/passwd');
    expectInvalidWithReason(wt);
  });

  // §18.7.6 / CWE-116/117/1007 — the rejected value is echoed into the rejection reason that reaches the flow
  // view; a value that fails the safe-id gate may carry control/bidi/zero-width/BOM/joiner bytes (all pass
  // `typeof === 'string'`), so the echoed value must be display-sanitized before it crosses IPC. A YAML
  // double-quoted scalar decodes the \uXXXX escapes into the real bytes: U+202E (RTL override), U+200D (ZWJ)
  // and U+0007 (C0) here.
  const DISPLAY_UNSAFE_OR_JOINER = new RegExp(
    '[\\p{Cc}\\u061C\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u200C\\u200D]',
    'u',
  );

  it('display-sanitizes the echoed rejected value in the rejection reason (no control/bidi/zero-width/joiner bytes)', () => {
    const wt = fx.makeWorktree('a2-pointer-unsafe-bytes');
    plantPointer(wt, '"a\\u202Eb\\u200Dc\\u0007"\n');
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('invalid');
    if (read.kind === 'invalid') expect(read.reason).not.toMatch(DISPLAY_UNSAFE_OR_JOINER);
  });

  it('length-bounds the echoed rejected value in the rejection reason (CWE-400)', () => {
    const wt = fx.makeWorktree('a2-pointer-unsafe-overlong');
    // Uppercase → fails the charset gate (not only the length bound), so the value is echoed into the reason.
    // The whole ~600-char value must not be pasted verbatim into a UI-bound string.
    plantPointer(wt, `${'A'.repeat(600)}\n`);
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('invalid');
    if (read.kind === 'invalid') expect(read.reason.length).toBeLessThan(200);
  });

  // §18.7.3 / §18.7.6 — an unusable pick refuses the run (the §18.1 flow-load error), so the reason must not tell
  // the operator a default flow is running in its place.
  it.each([
    ['an unsafe pointer value', (wt: string) => plantPointer(wt, '../../etc/passwd')],
    ['an unreadable pointer path', (wt: string) => mkdirSync(activeFlowPointerFile(wt), { recursive: true })],
  ])('the rejection reason for %s never claims the default flow runs instead', (_label, plant) => {
    const wt = fx.makeWorktree('a3-pointer-refusal-wording');
    plant(wt);
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('invalid');
    if (read.kind === 'invalid') expect(read.reason).not.toMatch(/running the default/i);
  });

  it('rejects an over-cap pointer FILE before parse (byte bound, CWE-400) even when its value would be valid', () => {
    const wt = fx.makeWorktree('a2-pointer-overcap');
    // A valid id whose FILE is padded past the byte cap with a YAML comment: without the cap the parser would
    // ignore the comment and yield the valid id; the cap must refuse it on size alone.
    plantPointer(wt, `feature-dev\n# ${'x'.repeat(MAX_POINTER_FILE_BYTES)}\n`);
    expectInvalidWithReason(wt);
  });

  it('rejects (never unset) when the pointer path is an unreadable non-file — a non-ENOENT read error', () => {
    const wt = fx.makeWorktree('a2-pointer-eisdir');
    // A directory planted at the pointer path makes the read throw EISDIR (non-ENOENT): it must be rejected
    // visibly, not collapse to the silent unset default (AC3 vs AC4).
    mkdirSync(activeFlowPointerFile(wt), { recursive: true });
    expectInvalidWithReason(wt);
  });
});

describe('activeFlowPointer — refuses a pointer path escaping the worktree via a planted symlink (§18.7.6, CWE-22/59)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('write throws and read rejects without following an escaping `.agent-terminal` symlink', () => {
    const wt = fx.makeFirstRunWorktree('a2-pointer-escape');
    const outside = fx.outsideDir('a2-pointer-escape-target');
    // A valid pointer planted at the redirect target proves the read never reaches it.
    writeFileSync(join(outside, ACTIVE_FLOW_FILE), 'sneaky-flow\n');
    fx.plantAgentTerminalDirEscape(wt, outside);

    expect(() => writeActiveFlow(wt, 'feature-dev')).toThrow();
    const read = readActiveFlow(wt);
    expect(read.kind).toBe('invalid');
    if (read.kind === 'invalid') expect(read.reason).toBeTruthy();
    expect(read).not.toEqual({ kind: 'value', id: 'sneaky-flow' });
    // clear is a no-op on an unresolvable path — it neither throws nor deletes through the symlink.
    expect(() => clearActiveFlow(wt)).not.toThrow();
  });
});

// A real FlowManager lifecycle rewrites flow-state.yaml wholesale (Terminate/Restart/undo) and clears the run
// disposition; AC6 requires the pointer's own disjoint file to survive all of it, and the reverse clause of AC8
// requires that wholesale write to leave the pointer byte-for-byte unchanged. The bare writeFlowState pin above
// cannot exercise that path (Terminate also clears the disposition, todos, and capture), so these drive the
// production manager through start/advance/undo/restart/terminate and re-read the pointer.
describe('activeFlowPointer — AC6/AC8: the selection survives a real Terminate/Restart/undo (§18.7.2)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const withLocalFlowRun = (name: string): { wt: string; mgr: ReturnType<typeof createFlowManager> } => {
    const wt = fx.makeWorktree(name);
    const globalDir = fx.makeWorktree(`${name}-global`);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    return { wt, mgr: createFlowManager({ globalDir }) };
  };

  it('a Terminate leaves the pointer file byte-for-byte unchanged and its value readable (AC6/AC8)', () => {
    const { wt, mgr } = withLocalFlowRun('a2-pointer-terminate');
    writeActiveFlow(wt, 'feature-dev');
    const before = readFileSync(activeFlowPointerFile(wt));
    mgr.start(wt);
    mgr.terminate(wt);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
  });

  it('a Restart (after the run reaches done) preserves the pointer value (AC6)', () => {
    const { wt, mgr } = withLocalFlowRun('a2-pointer-restart');
    writeActiveFlow(wt, 'feature-dev');
    const before = readFileSync(activeFlowPointerFile(wt));
    mgr.start(wt);
    mgr.advance(wt); // red -> green
    mgr.advance(wt); // green -> done
    mgr.restart(wt);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
  });

  it('an undo (of a completed run) preserves the pointer value (AC6)', () => {
    const { wt, mgr } = withLocalFlowRun('a2-pointer-undo');
    writeActiveFlow(wt, 'feature-dev');
    const before = readFileSync(activeFlowPointerFile(wt));
    mgr.start(wt);
    mgr.advance(wt); // red -> green
    mgr.advance(wt); // green -> done
    mgr.undo(wt); // done -> in_progress (undoes the completion)
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'feature-dev' });
  });

  it('only a Terminate re-enables a new selection — the gate refuses while begun, permits after Terminate (AC6)', () => {
    const { wt, mgr } = withLocalFlowRun('a2-pointer-reenable');
    const gate = createActiveFlowGate(createWorktreeLock({ lockRoot: join(fx.outsideDir('a2-pointer-locks'), 'locks') }));
    expect(gate.set(wt, 'feature-dev').ok).toBe(true);
    mgr.start(wt);
    expect(gate.set(wt, 'other').ok).toBe(false); // begun → locked
    mgr.terminate(wt);
    expect(gate.set(wt, 'other').ok).toBe(true); // Terminate re-enables selection
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'other' });
  });
});
