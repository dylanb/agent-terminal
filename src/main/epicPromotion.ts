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

/** What the promotion executor (S8 slice C) receives once the operator confirms. */
export interface EpicPromotionRequest {
  epic: number;
  pr: number | null;
  subTickets: EpicSubTicket[];
}

export interface EpicPromotionCoordinatorDeps {
  /** The gate's authored sub-tickets, or null when the plan is not an epic (the real port is
   *  `readEpicSubTicketsAtGate`; the coordinator stays a pure hold/resolve over it). */
  readSubTickets(def: LoopDefV2): EpicSubTicket[] | null;
  /** Raise the confirm-first preview naming every sub-ticket (→ flow:onEpicPromotionPreview). */
  emitPreview(msg: { repoDir: string; step: string; epic: number; pr: number | null; subTickets: { index: number; title: string }[] }): void;
  /** Create the sub-ticket chain + tracking issue (S8 slice C). A no-op stub until then. */
  runPromotion(repoDir: string, request: EpicPromotionRequest): Promise<void>;
  /** Complete the gate: persist the accept and stand the epic flow down (persistAccept + terminateFlow). */
  accept(repoDir: string, loop: string, step: string, turnKey: string): void;
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

export function createEpicPromotionCoordinator(deps: EpicPromotionCoordinatorDeps): EpicPromotionCoordinator {
  const held = new Map<string, { def: LoopDefV2; loop: string; step: string; turnKey: string; epic: number; pr: number | null }>();
  const key = (repoDir: string, step: string): string => `${repoDir}\0${step}`;
  return {
    maybeBegin(repoDir, def, loop, step, turnKey, refs) {
      const subTickets = deps.readSubTickets(def);
      if (subTickets === null || refs.epic === null) return false;
      held.set(key(repoDir, step), { def, loop, step, turnKey, epic: refs.epic, pr: refs.pr });
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
      // §27.10 — re-authorize at the operation: re-read the plan; a split that is no longer an epic is not acted on.
      const fresh = deps.readSubTickets(h.def);
      if (fresh === null) {
        deps.emitError(repoDir, 'the plan is no longer classified an epic — promotion was not run');
        deps.onViewChanged();
        return;
      }
      try {
        await deps.runPromotion(repoDir, { epic: h.epic, pr: h.pr, subTickets: fresh });
        deps.accept(repoDir, h.loop, h.step, h.turnKey);
        deps.audit(repoDir, 'epic-promotion', 0);
      } catch (e) {
        deps.emitError(repoDir, `epic promotion failed: ${errMsg(e)}`);
      }
      deps.onViewChanged();
    },
  };
}
