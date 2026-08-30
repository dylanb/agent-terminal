// §28.7 — the epic overlay. `readEpicSubTicketsAtGate` reads an epic-capable loop's `plan` artifact and parses
// its authored sub-tickets — the one read both the gate preview and the promotion consume, so they cannot
// drift. The coordinator is a gate-decision-time confirm-first hold, mirroring the bootstrap-conflict
// coordinator (§27.10).

import { readFileSync, statSync } from 'node:fs';
import { epicPlanWellFormed, parseEpicPlan, type EpicSubTicket } from '../shared/epicPlan';
import { errMsg } from './errno';
import type { LoopDefV2 } from './loopDefV2';
import type { EpicPromotionState } from './appLoopState';

// The plan is free-form agent prose read synchronously; cap it so a runaway artifact cannot block (CWE-400).
const EPIC_PLAN_MAX_BYTES = 2 * 1024 * 1024;

/** The ordered sub-tickets an epic-capable loop's plan declares, or null when the approve gate has no `promote`
 *  side-effect, the artifact is unreadable/oversized, or the plan is not classified an epic. */
export function readEpicSubTicketsAtGate(def: LoopDefV2): EpicSubTicket[] | null {
  const approve = def.gate.find((g) => g.option === 'approve');
  const promote = approve?.sideEffects.find((se) => se.kind === 'promote');
  const artifactId = promote && typeof promote.args.artifact === 'string' ? promote.args.artifact : null;
  if (artifactId === null) return null;
  const binding = [...def.inputs, ...def.outputs].find((b) => b.id === artifactId);
  if (binding === undefined) return null;
  let text: string;
  try {
    if (statSync(binding.path).size > EPIC_PLAN_MAX_BYTES) return null;
    text = readFileSync(binding.path, 'utf8');
  } catch {
    return null;
  }
  // §28.5.5 — the MINIMAL-contract gate BEFORE any preview: a not-well-formed epic (a sub-ticket missing its AC,
  // or a duplicate index that would collapse two slices onto one issue) must not be promotable, so the
  // confirm-first preview can never over-promise what promotion will actually create.
  if (!epicPlanWellFormed(text)) return null;
  const parsed = parseEpicPlan(text);
  if (parsed === null) return null;
  return parsed.subTickets;
}

/** The GitHub refs promotion acts on: the epic issue (from the gate's `ticket` ref) and its planning PR. */
export interface EpicPromotionRefs {
  epic: number | null;
  pr: number | null;
}

/** What the promotion executor receives once the operator confirms. */
export interface EpicPromotionRequest {
  epic: number;
  pr: number | null;
  subTickets: EpicSubTicket[];
}

// §27.10 (line 194) / §28.7 (line 176) / CLAUDE.md (line 95) — the labels every promoted sub-ticket carries.
export const EPIC_SUBTICKET_LABEL = 'agent-loop/subticket';
export const EPIC_READY_LABEL = 'agent-loop/ready';

// §27.10 — the machine footer appended to each posted sub-ticket body, delimited by `---` so a future pickup
// reader parses only past it. Distinct from EPIC_GRAMMAR's `Depends on:` (which the verbatim plan slice already
// carries with an authored ordinal), so the two never collide on divergent values. Single-sourced here for that
// reader to import.
export const EPIC_LINK_TOKEN = 'Epic:';
export const PRECEDING_SUBTICKET_TOKEN = 'Preceding sub-ticket:';

// A distinctive marker in the appended tracking checklist so the append is idempotent: if a resume re-reaches
// the append (the flag persist failed after the append landed), the marker's presence skips a second append.
export const EPIC_TRACKING_MARKER = '<!-- agent-terminal:epic-tracking -->';

/** The GitHub port the promotion executor drives — domain verbs, argv/stdin under the hood (the real adapter is
 *  appEpicPromotionGithub.ts), so the executor runs under a fake with no `gh`. */
export interface AppEpicPromotionGitHub {
  /** Create a sub-ticket, returning its issue number. */
  createIssue(title: string, body: string): Promise<number>;
  /** Add a label to an issue. Idempotent (a label already present is a no-op), so it is safe to re-apply on
   *  resume. */
  addLabel(issue: number, label: string): Promise<void>;
  /** Append `textToAppend` to an issue's body, preserving the existing body; §27.10 refuses an empty read (never
   *  clobbers the human's intent contract). Idempotent: if the body already contains `marker`, it skips. */
  appendIssueBody(issue: number, textToAppend: string, marker: string): Promise<void>;
  /** Close a PR. Idempotent (closing a closed PR is a no-op). */
  closePr(pr: number): Promise<void>;
}

/** The resumable promotion record (§28.7 AC3) — the real store is appLoopState's promotion.yaml; injected so the
 *  executor runs under an in-memory fake. `read` returns 'corrupt' for a present-but-malformed record (BLOCK). */
export interface EpicPromotionStore {
  read(epic: number): EpicPromotionState | 'corrupt' | null;
  write(state: EpicPromotionState): void;
}

/** The operator message when the epic's promotion record is present-but-unreadable — one source for both the
 *  gate-time block (maybeBegin) and the op-level guard (runEpicPromotion), so they read identically. */
export function promotionRecordUnreadableError(epic: number): string {
  return `a promotion record for this epic is unreadable — it may have already opened sub-ticket issues and added a tracking checklist to the epic, so do not remove .agent-terminal/loop/promotion-${epic}.yaml and re-approve until you have fully undone any partial run (delete those issues and remove the epic's tracking checklist), or the retry will duplicate issues and leave the checklist pointing at deleted ones`;
}

/** The operator message when a readable resumed promotion record's split has diverged from the current plan —
 *  one source for both the gate-time block (maybeBegin) and the op-level guard (runEpicPromotion). */
export function promotionRecordStaleError(epic: number): string {
  return `the plan changed since a partial promotion — its record already opened sub-ticket issues and may have added a tracking checklist to the epic, so clearing it and re-approving would duplicate the issues and leave the checklist pointing at the old ones; either restore the plan's split to match the record and re-approve, or fully undo the partial run — delete the opened issues and remove the epic's tracking checklist — before removing .agent-terminal/loop/promotion-${epic}.yaml, then re-approve`;
}

/** Whether a resumed promotion record has gone stale against the current plan: a recorded sub-ticket the plan no
 *  longer carries at the same index AND title would orphan a real slice or mis-stack the chain on resume. The
 *  gate-time block and the executor guard both derive "stale" from HERE, so they cannot diverge (§28.7). */
export function promotionRecordStale(created: { index: number; title: string }[], subTickets: EpicSubTicket[]): boolean {
  return created.some((rec) => {
    const cur = subTickets.find((st) => st.index === rec.index);
    return cur === undefined || cur.title !== rec.title;
  });
}

/** Create the sub-ticket chain + tracking issue (§28.7 AC2), RESUMABLY and IDEMPOTENTLY (AC3). Ordered so the
 *  approved plan is never lost: every sub-ticket (each carrying its plan slice verbatim) is created BEFORE the
 *  epic PR is closed. Each sub-ticket carries the epic link and the REAL preceding issue number, labelled
 *  uniformly (subticket + ready) — slice 1 is a sibling like the rest, none assigned. The store is consulted so
 *  a re-run creates only what is missing (a corrupt record blocks rather than duplicating public issues). */
export async function runEpicPromotion(gh: AppEpicPromotionGitHub, request: EpicPromotionRequest, store: EpicPromotionStore): Promise<void> {
  const existing = store.read(request.epic);
  if (existing === 'corrupt') {
    throw new Error(promotionRecordUnreadableError(request.epic));
  }
  // Creates are keyed on `index`; two sub-tickets sharing one would collapse onto a single issue, silently
  // dropping a slice the preview promised. Refuse the malformed split (defense-in-depth behind the gate's
  // epicPlanWellFormed check) rather than create fewer issues than were authorized.
  const seenIndices = new Set<number>();
  for (const st of request.subTickets) {
    if (seenIndices.has(st.index)) {
      throw new Error(`the plan has a duplicate sub-ticket index (#${st.index}) — two slices would collapse onto one issue; fix the plan and re-approve`);
    }
    seenIndices.add(st.index);
  }
  const state: EpicPromotionState = existing ?? { epic: request.epic, created: [], trackingAppended: false, prClosed: false };
  // Defense-in-depth behind the gate-time block (maybeBegin): refuse a record that went stale after confirm
  // rather than orphan real slices / mis-stack. (Fabricated issue NUMBERS with valid titles cannot be caught
  // without re-querying GitHub — a documented non-goal; the loop area is the pre-existing agent trust boundary.)
  if (promotionRecordStale(state.created, request.subTickets)) {
    throw new Error(promotionRecordStaleError(request.epic));
  }
  const issueByIndex = new Map(state.created.map((c) => [c.index, c.issue]));
  let preceding: number | null = null;
  for (const st of request.subTickets) {
    let issue = issueByIndex.get(st.index);
    if (issue === undefined) {
      const precedingRef = preceding === null ? 'none' : `#${preceding}`;
      const body = `${st.body}\n\n---\n${EPIC_LINK_TOKEN} #${request.epic}\n${PRECEDING_SUBTICKET_TOKEN} ${precedingRef}\n`;
      issue = await gh.createIssue(st.title, body);
      // Record the created issue BEFORE labelling, so a label failure cannot lose it and force a re-create.
      state.created.push({ index: st.index, issue, title: st.title });
      try {
        store.write(state);
      } catch (e) {
        // The issue exists on GitHub but its record could not be saved; name it so the operator removes it before
        // re-approving — a blind retry reads a store missing it and creates a DUPLICATE public issue (§28.7 AC3).
        throw new Error(`sub-ticket #${issue} was created but its promotion record could not be saved (${errMsg(e)}); remove issue #${issue} before re-approving or the retry will duplicate it`);
      }
      issueByIndex.set(st.index, issue);
    }
    // Labels are idempotent, so (re)apply them for every sub-ticket — a resume completes labelling a record
    // whose labels did not land, without re-creating the issue.
    await gh.addLabel(issue, EPIC_SUBTICKET_LABEL);
    await gh.addLabel(issue, EPIC_READY_LABEL);
    preceding = issue;
  }
  const checklist = `\n\n${EPIC_TRACKING_MARKER}\n## Sub-tickets\n${request.subTickets.map((st) => `- [ ] #${issueByIndex.get(st.index)} — ${st.title}`).join('\n')}\n`;
  if (!state.trackingAppended) {
    await gh.appendIssueBody(request.epic, checklist, EPIC_TRACKING_MARKER); // idempotent via the marker
    state.trackingAppended = true;
    store.write(state);
  }
  if (request.pr !== null && !state.prClosed) {
    await gh.closePr(request.pr);
    state.prClosed = true;
    store.write(state);
  }
}

export interface EpicPromotionCoordinatorDeps {
  /** The gate's authored sub-tickets, or null when the plan is not an epic (the real port is
   *  `readEpicSubTicketsAtGate`; the coordinator stays a pure hold/resolve over it). */
  readSubTickets(def: LoopDefV2): EpicSubTicket[] | null;
  /** Why the epic's resumable promotion record forbids promoting THIS plan at the gate, or null when it does not
   *  — the authorizing precondition checked BEFORE the preview. `corrupt`: present-but-unreadable; `stale-split`:
   *  a readable resumed record whose created slices have diverged from the current plan. Its wiring MUST consult
   *  the SAME store `runEpicPromotion` does and derive "stale" from the SAME `promotionRecordStale`, so the gate
   *  block and the op-level guard cannot diverge (never the store `read` primitive — the domain concept). */
  promotionRecordBlock(repoDir: string, epic: number, subTickets: EpicSubTicket[]): EpicPromotionGateBlock | null;
  /** Raise the confirm-first preview naming every sub-ticket (→ flow:onEpicPromotionPreview). */
  emitPreview(msg: { repoDir: string; step: string; epic: number; pr: number | null; subTickets: { index: number; title: string }[] }): void;
  /** Create the sub-ticket chain + tracking issue (§28.7 AC2/AC3) — resumably, over the promotion store. */
  runPromotion(repoDir: string, request: EpicPromotionRequest): Promise<void>;
  /** Persist the terminal gate accept (writeAppLoopState `accepted`). Kept SEPARATE from `terminateFlow` so a
   *  persist failure is surfaced distinctly and leaves the gate re-decidable, never mislabeled as a promotion
   *  failure (the D48 split — appGateDecision). */
  persistAccept(repoDir: string, loop: string, step: string, turnKey: string): void;
  /** Stand the epic flow down (flow.terminate). Best-effort after the persist: a failure here leaves the gate
   *  accepted but not stood down, recoverable, and must not read as a promotion failure. */
  terminateFlow(repoDir: string): void;
  audit(repoDir: string, cmd: string, exit: number | null): void;
  emitError(repoDir: string, reason: string): void;
  onViewChanged(): void;
}

/** §28.7 — the three ways an approve at the epic gate resolves. The caller fires the §25 preview audit iff the
 *  outcome is `preview-raised` (CODE-STANDARDS discriminated-union for mutually-exclusive modes). */
export type EpicGateOutcome =
  | { kind: 'not-epic' }
  | { kind: 'preview-raised' }
  | { kind: 'blocked' };

export interface EpicPromotionCoordinator {
  /** Classify an approve at the epic gate into an `EpicGateOutcome`. Authorizing preconditions are checked
   *  HERE, before the preview is raised (§28.7 / CODE-STANDARDS policy-checked-at-the-operation). */
  maybeBegin(repoDir: string, def: LoopDefV2, loop: string, step: string, turnKey: string, refs: EpicPromotionRefs): EpicGateOutcome;
  /** Answer a held promotion: confirm promotes then accepts + stands down; decline drops it and leaves the gate. */
  resolve(repoDir: string, step: string, confirm: boolean): Promise<void>;
}

/** Whether two parsed splits name the same sub-tickets in the same order — the confirm-first fidelity check:
 *  the promotion must act only on the split the operator was shown (§6 / CWE-367). */
function sameSplit(a: EpicSubTicket[], b: EpicSubTicket[]): boolean {
  return a.length === b.length && a.every((t, i) => t.index === b[i].index && t.title === b[i].title);
}

/** Why a persisted promotion record forbids promoting a plan at the gate: `corrupt` (present-but-unreadable) or
 *  `stale-split` (readable, but its recorded slices have diverged from the current plan). Each maps to its OWN
 *  §28 block audit entry so the run log never blurs the two outcomes (CODE-STANDARDS run-log truthfulness). */
export type EpicPromotionGateBlock = 'corrupt' | 'stale-split';

const EPIC_PROMOTION_BLOCKED_UNREADABLE = '§28 epic-promotion blocked — unreadable promotion record';
const EPIC_PROMOTION_BLOCKED_STALE = '§28 epic-promotion blocked — plan diverged from partial-promotion record';
const EPIC_PROMOTION_BLOCKED_UNRESOLVABLE = '§28 epic-promotion blocked — unresolvable epic issue';

const EPIC_ISSUE_UNRESOLVABLE_ERROR = 'this epic plan has no resolvable epic issue to promote — its flow carries no epic issue reference; fix the flow state and re-approve';

export function createEpicPromotionCoordinator(deps: EpicPromotionCoordinatorDeps): EpicPromotionCoordinator {
  const held = new Map<string, { def: LoopDefV2; loop: string; step: string; turnKey: string; epic: number; pr: number | null; subTickets: EpicSubTicket[] }>();
  const key = (repoDir: string, step: string): string => `${repoDir}\0${step}`;
  return {
    maybeBegin(repoDir, def, loop, step, turnKey, refs) {
      const subTickets = deps.readSubTickets(def);
      if (subTickets === null) return { kind: 'not-epic' };
      // §28.7 — a well-formed epic plan whose epic issue is unresolvable cannot be promoted; block loudly here
      // rather than fall through to the silent single-ticket accept (the UI-offered-X / got-Y divergence).
      if (refs.epic === null) {
        deps.emitError(repoDir, EPIC_ISSUE_UNRESOLVABLE_ERROR);
        deps.audit(repoDir, EPIC_PROMOTION_BLOCKED_UNRESOLVABLE, 1);
        return { kind: 'blocked' };
      }
      // §28.7 — the promotion record is the sole guard against re-creating duplicate public issues, so a record
      // that forbids promotion must refuse HERE, before the confirm preview is raised (never prompt-then-refuse).
      const block = deps.promotionRecordBlock(repoDir, refs.epic, subTickets);
      if (block !== null) {
        const corrupt = block === 'corrupt';
        deps.emitError(repoDir, corrupt ? promotionRecordUnreadableError(refs.epic) : promotionRecordStaleError(refs.epic));
        deps.audit(repoDir, corrupt ? EPIC_PROMOTION_BLOCKED_UNREADABLE : EPIC_PROMOTION_BLOCKED_STALE, 1);
        return { kind: 'blocked' };
      }
      held.set(key(repoDir, step), { def, loop, step, turnKey, epic: refs.epic, pr: refs.pr, subTickets });
      deps.emitPreview({ repoDir, step, epic: refs.epic, pr: refs.pr, subTickets: subTickets.map((t) => ({ index: t.index, title: t.title })) });
      return { kind: 'preview-raised' };
    },
    async resolve(repoDir, step, confirm) {
      const h = held.get(key(repoDir, step));
      if (h === undefined) return; // no pending promotion — a raced or stale answer
      held.delete(key(repoDir, step));
      if (!confirm) {
        deps.audit(repoDir, '§28 epic-promotion declined', 0);
        deps.onViewChanged();
        return;
      }
      // §27.10 / CWE-367 — re-authorize at the operation: re-read the plan and require the split still matches
      // what the operator was shown; a plan that is no longer an epic OR whose split changed is not acted on.
      const fresh = deps.readSubTickets(h.def);
      if (fresh === null || !sameSplit(fresh, h.subTickets)) {
        deps.emitError(
          repoDir,
          fresh === null
            ? 'the plan is no longer classified an epic — promotion was not run'
            : 'the plan changed since you reviewed the split — re-approve to see the new sub-tickets',
        );
        deps.onViewChanged();
        return;
      }
      // The outward promotion runs first, in its OWN guard: a failure keeps the gate un-accepted and re-decidable
      // (the approved plan is never lost), and it is never confused with a persist failure.
      try {
        await deps.runPromotion(repoDir, { epic: h.epic, pr: h.pr, subTickets: fresh });
        deps.audit(repoDir, '§28 epic-promotion', 0);
      } catch (e) {
        deps.emitError(repoDir, `epic promotion failed: ${errMsg(e)}`);
        deps.onViewChanged();
        return;
      }
      // D48 — persist the accept in its own guard: a persist failure surfaces distinctly and leaves the gate
      // re-decidable, never mislabeled as a promotion failure (mirrors appGateDecision).
      try {
        deps.persistAccept(repoDir, h.loop, h.step, h.turnKey);
      } catch (e) {
        deps.emitError(repoDir, `could not persist gate accept: ${errMsg(e)}`);
        deps.onViewChanged();
        return;
      }
      // Best-effort — the accept persisted, so a terminate failure is recorded, never surfaced as a promotion
      // failure (the gate view never renders again once accepted).
      try {
        deps.terminateFlow(repoDir);
      } catch (e) {
        deps.audit(repoDir, `§28 epic-promotion terminate failed: ${errMsg(e)}`, 1);
      }
      deps.onViewChanged();
    },
  };
}
