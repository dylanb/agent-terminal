// §28.7 — the epic overlay. `readEpicSubTicketsAtGate` reads an epic-capable loop's `plan` artifact and parses
// its authored sub-tickets (the one read both the gate preview and the promotion consume, so they cannot
// drift). The coordinator is a gate-decision-time confirm-first hold, mirroring the bootstrap-conflict
// coordinator (§27.10): maybeBegin intercepts an approve on an epic plan and holds pending the operator's
// confirm; resolve completes it — confirm promotes then accepts + stands the flow down, decline drops it.

import { readFileSync, statSync } from 'node:fs';
import { isEpicPlan, parseEpicPlan, type EpicSubTicket } from '../shared/epicPlan';
import { errMsg } from './errno';
import type { LoopDefV2 } from './loopDefV2';

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
  if (!isEpicPlan(text)) return null;
  const parsed = parseEpicPlan(text);
  if (parsed === null || parsed.subTickets.length === 0) return null;
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

// §27.10 — the labels every promoted sub-ticket carries: the marker pickup keys on, and the ready label that
// makes the chain pickable without a second per-slice human gate (the recorded operator override).
export const EPIC_SUBTICKET_LABEL = 'agent-loop/subticket';
export const EPIC_READY_LABEL = 'agent-loop/ready';

/** The GitHub port the promotion executor drives — domain verbs, argv/stdin under the hood (the real adapter is
 *  appEpicPromotionGithub.ts), so the executor runs under a fake with no `gh`. */
export interface AppEpicPromotionGitHub {
  /** Create a sub-ticket, returning its issue number (`gh issue create`, body on stdin). */
  createIssue(title: string, body: string): Promise<number>;
  /** Add a label to an issue (`gh issue edit --add-label`). */
  addLabel(issue: number, label: string): Promise<void>;
  /** Read the issue body and append `textToAppend` (read-modify-write; refuses to write over an empty read so a
   *  failed/empty read can never clobber the human's intent contract — §27.10). */
  appendIssueBody(issue: number, textToAppend: string): Promise<void>;
  /** Close a PR (`gh pr close`). */
  closePr(pr: number): Promise<void>;
}

/** Create the sub-ticket chain + tracking issue (§28.7 AC2). Ordered so the approved plan is never lost: every
 *  sub-ticket (each carrying its plan slice verbatim) is created BEFORE the epic PR is closed. Each sub-ticket
 *  carries the epic link and the REAL preceding issue number (resolved as creation proceeds), labelled
 *  uniformly (subticket + ready) — slice 1 is a sibling like the rest (operator decision), none assigned. */
export async function runEpicPromotion(gh: AppEpicPromotionGitHub, request: EpicPromotionRequest): Promise<void> {
  const created: { issue: number; title: string }[] = [];
  let preceding: number | null = null;
  for (const st of request.subTickets) {
    const dependsOn = preceding === null ? 'none' : `#${preceding}`;
    const body = `${st.body}\n\n---\nEpic: #${request.epic}\nDepends on: ${dependsOn}\n`;
    const issue = await gh.createIssue(st.title, body);
    await gh.addLabel(issue, EPIC_SUBTICKET_LABEL);
    await gh.addLabel(issue, EPIC_READY_LABEL);
    created.push({ issue, title: st.title });
    preceding = issue;
  }
  const checklist = `\n\n## Sub-tickets\n${created.map((c) => `- [ ] #${c.issue} — ${c.title}`).join('\n')}\n`;
  await gh.appendIssueBody(request.epic, checklist);
  if (request.pr !== null) await gh.closePr(request.pr);
}

export interface EpicPromotionCoordinatorDeps {
  /** The gate's authored sub-tickets, or null when the plan is not an epic (the real port is
   *  `readEpicSubTicketsAtGate`; the coordinator stays a pure hold/resolve over it). */
  readSubTickets(def: LoopDefV2): EpicSubTicket[] | null;
  /** Raise the confirm-first preview naming every sub-ticket (→ flow:onEpicPromotionPreview). */
  emitPreview(msg: { repoDir: string; step: string; epic: number; pr: number | null; subTickets: { index: number; title: string }[] }): void;
  /** Create the sub-ticket chain + tracking issue (S8 slice C). A no-op stub until then. */
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

export interface EpicPromotionCoordinator {
  /** Intercept an approve on an epic plan: raise the preview and hold, returning true. Returns false (the
   *  normal accept runs) for a non-epic plan, a gate with no promote side-effect, or an unknown epic issue. */
  maybeBegin(repoDir: string, def: LoopDefV2, loop: string, step: string, turnKey: string, refs: EpicPromotionRefs): boolean;
  /** Answer a held promotion: confirm promotes then accepts + stands down; decline drops it and leaves the gate. */
  resolve(repoDir: string, step: string, confirm: boolean): Promise<void>;
}

/** Whether two parsed splits name the same sub-tickets in the same order — the confirm-first fidelity check:
 *  the promotion must act only on the split the operator was shown (§6 / CWE-367). */
function sameSplit(a: EpicSubTicket[], b: EpicSubTicket[]): boolean {
  return a.length === b.length && a.every((t, i) => t.index === b[i].index && t.title === b[i].title);
}

export function createEpicPromotionCoordinator(deps: EpicPromotionCoordinatorDeps): EpicPromotionCoordinator {
  const held = new Map<string, { def: LoopDefV2; loop: string; step: string; turnKey: string; epic: number; pr: number | null; subTickets: EpicSubTicket[] }>();
  const key = (repoDir: string, step: string): string => `${repoDir}\0${step}`;
  return {
    maybeBegin(repoDir, def, loop, step, turnKey, refs) {
      const subTickets = deps.readSubTickets(def);
      if (subTickets === null || refs.epic === null) return false;
      held.set(key(repoDir, step), { def, loop, step, turnKey, epic: refs.epic, pr: refs.pr, subTickets });
      deps.emitPreview({ repoDir, step, epic: refs.epic, pr: refs.pr, subTickets: subTickets.map((t) => ({ index: t.index, title: t.title })) });
      return true;
    },
    async resolve(repoDir, step, confirm) {
      const h = held.get(key(repoDir, step));
      if (h === undefined) return; // no pending promotion — a raced or stale answer
      held.delete(key(repoDir, step));
      if (!confirm) {
        deps.audit(repoDir, 'epic-promotion-declined', 0);
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
        deps.audit(repoDir, 'epic-promotion', 0);
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
        deps.audit(repoDir, `epic-promotion terminate failed: ${errMsg(e)}`, 1);
      }
      deps.onViewChanged();
    },
  };
}
