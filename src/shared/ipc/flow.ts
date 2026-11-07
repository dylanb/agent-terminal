import type { AppBootstrapConflictTarget, TicketRef } from '../appBootstrap';
import type { ConsolidatorVerdict } from '../consolidatorOutput';
import type { StartednessSignal } from '../flowStarted';
import type { AutoHaltReason, FailedEffectState } from '../gateAuthority';
import type { LoopActivity } from '../loopActivity';
import type { HeldRunView } from '../runHold';
import type { RunIdentity } from '../runIdentity';
import type { AgentState } from './monitor';
import type { ChannelSpecs, SessionId } from './session';

export const FLOW_CHANNELS = {
  flowState: {
    name: 'flow:state',
    does: "The renderer reads the named worktree's flow state.",
  },
  flowStart: {
    name: 'flow:start',
    does: 'The renderer starts the flow, moving it from not started to in progress.',
  },
  flowAdvance: {
    name: 'flow:advance',
    does: 'The renderer advances the flow past its current step, or past the named step only while it is still current.',
  },
  flowRestart: {
    name: 'flow:restart',
    does: 'The renderer restarts a finished flow from its first step, re-running its entry actions.',
  },
  flowUndo: {
    name: 'flow:undo',
    does: "The renderer reverts a manual advance without re-running the step's entry actions.",
  },
  flowTerminate: {
    name: 'flow:terminate',
    does: "The renderer abandons the flow, resetting it to not started and clearing the repo's todos and captures.",
  },
  flowProvideInput: {
    name: 'flow:provideInput',
    does: "The renderer answers a step's input prompt, which main saves and acts on only while that step is still current.",
  },
  flowSetTitle: {
    name: 'flow:setTitle',
    does: "The renderer names the worktree's work, or clears the name with a blank title.",
  },
  flowSetActiveFlow: {
    name: 'flow:setActiveFlow',
    does: "The renderer picks the worktree's flow, which main refuses once the run has started.",
  },
  flowClearActiveFlow: {
    name: 'flow:clearActiveFlow',
    does: 'The renderer returns the worktree to the default flow, refused exactly as flow:setActiveFlow is.',
  },
  flowListCatalog: {
    name: 'flow:listCatalog',
    does: "The renderer lists the flows the worktree's picker can choose from.",
  },
  flowRebindHeldRun: {
    name: 'flow:rebindHeldRun',
    does: "The renderer rebinds the worktree's held run to a chosen flow, which either resumes the run or ends it.",
  },
  flowConfirmRunPickup: {
    name: 'flow:confirmRunPickup',
    does: 'The renderer confirms the pickup the operator was shown, naming the run, PR and ticket so it releases only that hold.',
  },
  flowOnStateChanged: {
    name: 'flow:onStateChanged',
    does: 'Main reports that a flow-relevant input changed, so the renderer re-reads flow:state.',
  },
  flowRevealLoop: {
    name: 'flow:revealLoop',
    does: 'Main asks the renderer to reveal the loop read-out after the operator clicked the OS attention notification.',
  },
  flowOnBootstrapError: {
    name: 'flow:onBootstrapError',
    does: "Main reports that a loop step's bootstrap could not proceed, with the reason and the repo and step it failed on.",
  },
  flowOnAppBootstrapConflict: {
    name: 'flow:onAppBootstrapConflict',
    does: "Main asks the operator what to do when a loop step's branch already exists locally, on the remote or with pull requests.",
  },
  flowResolveAppBootstrapConflict: {
    name: 'flow:resolveAppBootstrapConflict',
    does: 'The renderer answers a branch conflict for the step it names, either wiping the conflicting branch or leaving it.',
  },
  flowOnAdoptTicketChoice: {
    name: 'flow:onAdoptTicketChoice',
    does: 'Main asks the operator which of the tickets a pull request closes is the primary ticket of the run adopting it.',
  },
  flowResolveAdoptTicket: {
    name: 'flow:resolveAdoptTicket',
    does: 'The renderer answers one ticket-choice offer with the ticket the operator picked, or with Cancel, and learns whether main accepted it.',
  },
  flowOnEpicPromotionPreview: {
    name: 'flow:onEpicPromotionPreview',
    does: 'Main shows the operator every GitHub change an epic promotion will make, before it runs.',
  },
  flowResolveEpicPromotion: {
    name: 'flow:resolveEpicPromotion',
    does: 'The renderer answers the epic-promotion preview, where confirm runs the promotion and anything else declines it.',
  },
  flowGithubRef: {
    name: 'flow:githubRef',
    does: "The renderer asks for a GitHub issue's or pull request's title, body and URL, getting null when it can't be resolved.",
  },
  flowAppRouteOut: {
    name: 'flow:appRouteOut',
    does: 'The renderer retries, accepts or terminates a stalled loop work turn, naming the step and turn it acts on.',
  },
  flowAppGateDecision: {
    name: 'flow:appGateDecision',
    does: "The renderer sends the human's decision at a loop gate, naming the step and turn it acts on, and learns whether it landed once main has acted on it.",
  },
  flowAppRequestChanges: {
    name: 'flow:appRequestChanges',
    does: 'The renderer sends request-changes feedback from a loop gate and learns whether the next review round started.',
  },
  flowAppRedo: {
    name: 'flow:appRedo',
    does: 'The renderer sends a redo instruction from a loop gate and learns whether the work turn restarted.',
  },
  flowAppBackToRed: {
    name: 'flow:appBackToRed',
    does: 'The renderer sends the flow back to its return step with a brief and learns whether the flow is back there.',
  },
  flowArmInterrupt: {
    name: 'flow:armInterrupt',
    does: "The renderer arms an interrupt that sends the loop step to its human gate at the consolidator's next run.",
  },
  appOpenExternal: {
    name: 'app:openExternal',
    does: 'The renderer asks main to open a GitHub https URL in the OS browser, which main refuses for any other URL.',
  },
} as const satisfies ChannelSpecs;

// ---- Flow lifecycle (§18.2 / §24.2.2) ----

/** A manual step's lifecycle: not started, being worked, or completed (terminal) — §18.2.
 *  `error` is not a step state but a load failure: the `flow.yaml` (§18.1) was absent,
 *  malformed, or schema-invalid, so there is no step to drive (§24.2.2 S2). */
export type FlowStatus = 'not_started' | 'in_progress' | 'done' | 'error';

/** The live, derived status of an in-progress step (§22.3 / §24.2.2 S5): a pure function of the
 *  flow state, the repo's todo list, and the §8.3 agent activity. `ready` (every todo is done) is
 *  the gate-readiness signal. Present only while `status === 'in_progress'`. */
export interface FlowDerived {
  activity: AgentState;
  todosDone: number;
  todosTotal: number;
  ready: boolean;
}

/** §27.9.1 */
export interface FlowAutoGateView {
  deciding: boolean;
  hung: boolean;
  haltReasons: { reason: AutoHaltReason; detail?: string }[];
  failedEffect?: { state: FailedEffectState; detail: string };
}

/** The §27 loop view (§24.2.3 T2 / §27.15): the engine-neutral vocabulary the loop panel and strip
 *  render, produced by the bound engine — not a mirror of any file the app reads.
 *  `status` is the per-LoopDef state-machine string (unbounded — the
 *  strip maps it onto a generic 3-tone pill, never an enum); `pr`/`branch` are null before the loop
 *  has a PR. `ready` is the §19.2 advance gate — gate-driven when the bound LoopDef resolves (true
 *  only at a TERMINAL gate, the loop's exit), else the documented awaiting-human-* family. */
export interface FlowLoopView {
  status: string;
  /** The run's iteration counter (§27.5). Absent means NO ROUND HAS RUN — the honest value for a
   *  §27 def that resolved before any round (a run-less view) and for a def that failed to resolve;
   *  a coalesce-to-zero would fabricate a round identity the dedup key and the audit both key on. Every
   *  consumer (panel, strip, dedup) omits its iteration read-out when absent rather than showing 0. */
  iteration?: number;
  pr: number | null;
  branch: string | null;
  ready: boolean;
  /** Whether this view's `gateOptions` are ACTIONABLE — the human can click them to decide the gate.
   *  Read through the shared `loopGateActionable`, whose default governs: a producer marks a view
   *  display-only by opting in — the §27 run-less view sets `actionable: false` — and anything that does not
   *  opt in is actionable, so every hand-constructed awaiting-gate view keeps its controls and the same
   *  `gateOptions` field never means two things. The default lives once, in `loopGateActionable`. */
  actionable?: boolean;
  /** The current status's gate `human_options` (§18.1/§19.4) — the gate UI's variable option set
   *  (`approve`/`request-changes`/`impasse`), OR the options a §27 def declares for a run-less view.
   *  The producing engine owns when to fill it; `actionable` carries whether they are clickable. */
  gateOptions?: string[];
  /** The step a `back-to-red` decision at this gate returns the flow to; present only when the gate offers it. */
  reopenStep?: string;
  /** Observable "the loop is blocked awaiting a human" classification (§24.2.3 T4): true at a
   *  LoopDef human-decision gate (or, with no resolvable LoopDef, the shared awaiting-human/impasse
   *  family), false at a terminal hand-off or mid-work. Computed by main (where the LoopDef
   *  resolves); the renderer reads it rather than re-deriving the gate/awaiting logic. Always set on
   *  a derived loop view — the `?` is for hand-constructed views only. */
  humanNeeded?: boolean;
  autoGate?: FlowAutoGateView;
  /** §27.12 — the reason the current turn failed (or, on a marked binding, why the step names no surviving
   *  engine), present only at `status: 'error'`. Lets the loop panel show WHY the loop stopped (e.g. "no
   *  Claude at the prompt") rather than a bare "error", and is cleared the moment the status recovers.
   *  Absent on every non-error view. */
  errorReason?: string;
  /** §27.12 — the turn stopped on a stall after its prompt went in, so its own done-signal still completes it. */
  stalled?: boolean;
  /** §27.12/§27.15 — the identity of the §27 (app-namespace) work turn this view reflects: the flow step it
   *  runs against and its turn key. Present ONLY on a live §27 run view (working/error/complete); absent on
   *  the §27 run-less/def-failure view (no turn has started). The panel carries this onto the §27-only error
   *  route-out (retry / accept / terminate) so the receiver acts on the identity it names, never ambient
   *  state (§6). Additive and §27-only (§27.15). */
  appTurn?: { step: string; turnKey: string };
  /** §27.4/§27.6/AC8 — the def's reviewer catalog (every persona the loop can invoke) and, once the
   *  consolidator has chosen, `chosenRoster` (the personas the next/current round runs). Both are the SAME
   *  parsed-def data the round is drawn from, so the displayed roster and the round's actual roster cannot
   *  drift. Additive and §27-only. */
  catalog?: string[];
  chosenRoster?: string[];
  /** §27.6/AC5/AC9 — the round's consolidator verdict, the closed `ConsolidatorVerdict` set the engine and
   *  loop-state already carry, so a fourth value cannot cross the wire. Only under `stop for a human` does
   *  `verdictReason` accompany it. The panel surfaces the verdict at the gate, and the would-be verdict on an
   *  armed interrupt. Additive and §27-only. */
  verdict?: ConsolidatorVerdict;
  verdictReason?: string;
  /** §27.9/AC6/AC11 — the polish stand-down is active for this step: the orchestrator has stood down and the
   *  operator owns the keyboard, so the panel shows the polish view (only the approve control, which ends it)
   *  rather than the full gate options. App-owned loop state, persisted independently of the run-state so it
   *  survives a relaunch until the operator approves. Additive and §27-only. */
  polish?: boolean;
  /** §28.5.3/§28.8.3 — the test-glob files the machine detected changed during a GREEN turn, recorded under
   *  this run's step. A NON-blocking detect-and-escalate flag: the panel surfaces it for the regression-guard
   *  persona + the human gate. Absent when none changed (a clean GREEN records an empty flag, which does not
   *  show) or when the record is for another step. Additive and §27-only. */
  changedTests?: string[];
  /** §28.7 — the epic decomposition (src/shared/epicPlan.ts) surfaced at the gate for an epic-capable loop; the
   *  operator judges the split before approving (§27.10). Absent otherwise. Additive and §27-only. */
  epic?: { subTickets: { index: number; title: string }[] };
}

/** The GitHub issue (ticket) and PR a flow is working (§24.2.3 T7). Numbers only — the title, body,
 *  and url are fetched lazily via `flow:githubRef` so `flow:state` stays synchronous and best-effort.
 *  `ticket` is the value of the flow's `github-ticket`-typed input; `pr` is the value of the flow's
 *  `pr`-typed input. Either may be absent; the whole field is absent when neither resolves. Visibility is
 *  gated on flow progress (§24.2.3 T7): a typed-input ref surfaces only once a step requesting that input
 *  is entered. */
export interface FlowRefs {
  ticket?: number;
  pr?: number;
}

/** Whether a refs payload actually carries a number to show. The one definition both processes share
 *  (CLAUDE.md shared-semantics): main emits `undefined` for an empty refs object, and every renderer
 *  consumer (strip read-out, docked panel, composition root) gates on this same predicate, so they
 *  cannot drift on what counts as renderable refs. */
export function hasFlowRefs(refs: FlowRefs | undefined): refs is FlowRefs {
  return refs !== undefined && (refs.ticket !== undefined || refs.pr !== undefined);
}

/** Which kind of GitHub ref to resolve (§24.2.3 T7): a `ticket` is an issue, `pr` a pull request. */
export type GithubRefKind = 'issue' | 'pr';

/** The fetched GitHub ref detail (§24.2.3 T7): the title + description body the popout shows and the
 *  canonical `url` the link opens. Resolved best-effort via `gh`; the whole result is null when it
 *  can't be resolved (no `gh`, not a GitHub repo, offline), so the popout shows the number alone. */
export interface GithubRef {
  title: string;
  body: string;
  url: string;
}

/** One typed input the renderer's modal must collect (§18.4 / §24.2.3 T3): the field `name` and its
 *  catalog `type` (`github-ticket`/`pr`/`files`/`free-text`), which labels and shapes the picker. */
export interface FlowInputSpec {
  name: string;
  type: string;
}

/** A step-entry prompt for unsatisfied required inputs (§18.4 / §24.2.3 T3): carried on a transition
 *  view when entering a step whose `bootstrap` needs an input that isn't resolved yet. `inputs` are
 *  the fields to collect; `bootstrap` names the command they feed (e.g. `agent-loop pickup`) for the
 *  modal's helper text. The renderer opens its modal, collects values, and calls `flow:provideInput`. */
export interface FlowPrompt {
  inputs: FlowInputSpec[];
  bootstrap: string;
}

/** The flow's live view (§22.3 status strip): the current step's name, its 1-based
 *  `position` within `total` steps, and its `status`. S2 sources the step from
 *  `<worktree>/.agent-terminal/flow.yaml` (§18.1); on a load failure `status` is
 *  `error` and `error` carries the human-readable reason (position/total 0). */
export interface FlowStateView {
  stepName: string;
  /** Every step's name, in flow order (§24.2.3 T1) — the §22.3 rail renders one station per entry;
   *  `stepName` is `steps[position - 1]`. Empty on an `error` view (no steps to show). */
  steps: string[];
  position: number;
  total: number;
  status: FlowStatus;
  error?: string;
  /** A one-shot transient notice — the §19.3 running-process refusal when a skill couldn't be injected
   *  over a busy shell, or AC 5's migration notice (§24.2.2 S4). Carried on a transition response, or on a
   *  `state` response when an asynchronous producer (the bootstrap coordinator) has one pending; the strip
   *  holds it across passive re-pulls and clears it on the next transition. */
  notice?: string;
  /** The active step's bound `todo_template:` ref (§18.6), when it declares one — the default the
   *  on-demand todo-template picker offers while the step is active (§6/§4.1). */
  templateRef?: string;
  /** Live derived status (§22.3 / §24.2.2 S5): agent activity + todo completion + gate readiness.
   *  Present only on an `in_progress` view (computed by main from the repo's todos + §8.3 activity). */
  derived?: FlowDerived;
  /** What the loop MECHANICS are doing right now: the surviving `bootstrapping` phrase (§27.10). The
   *  descriptor's PRESENCE is "the loop is busy"; there is no idle descriptor. Top-level (NOT under `loop`)
   *  because a bootstrap runs before the §27 run state exists; absent when the loop mechanics are idle. */
  loopActivity?: LoopActivity;
  /** The §27 loop view (§27.15): present once a `loop` step has been entered (and stays for the run,
   *  including any later manual step), produced by the §27 provider — not a mirror of any file the app
   *  reads. Parallel to `derived` (NOT nested) — loop state outlives the manual in_progress window. */
  loop?: FlowLoopView;
  /** The ticket + PR the flow is working (§24.2.3 T7): numbers resolved synchronously from the flow's
   *  typed inputs, gated on flow progress (see `FlowRefs`). The renderer fetches each one's title/body/url
   *  lazily via `flow:githubRef`. */
  refs?: FlowRefs;
  /** The name the user gave this worktree's work (§22.3.1), persisted in flow-state.yaml. The status bar
   *  shows it only when neither a PR nor a ticket supplies a title (`deriveStatusBar`) — it is outranked,
   *  never discarded, so it returns if the refs go away. Absent when the user has named nothing. */
  userTitle?: string;
  /** A one-shot step-entry input prompt (§18.4 / §24.2.3 T3): present on a `start`/`restart`/`advance`
   *  response when the entered step's `bootstrap` needs an unsatisfied required input. The renderer opens
   *  its modal and answers via `flow:provideInput`. Transition-driven — never part of `state()`. */
  prompt?: FlowPrompt;
  /** §18.7.4 — the RAW durable run started-ness, distinct from (and never) the load-maskable `status`: a reset
   *  whose run record could not be removed shows `status: 'not_started'` while the run stays `'started'`.
   *  Classify it only through `isSelectionLocked` (shared/flowStarted.ts). */
  runStarted: StartednessSignal;
  /** §18.7.3 */
  runHold?: HeldRunView;
  /** §27.13 — present while the run is held for the operator to confirm its ticket and pull request. */
  pickupConfirm?: PickupConfirmView;
}


/** §27.13 */
export type PickupConfirmView =
  | { run: RunIdentity; state: 'looking' }
  | { run: RunIdentity; state: 'proposed'; branch: string | null; pr: number | null; ticket: number | null; problems: string[]; adopted?: AdoptedPickupConfirm };

/** An adopting run's confirm: the primary ticket its start recorded, shown read-only, or why it cannot be
 *  recovered. The confirm sends the primary's number; its repository stays in main's record. */
export type AdoptedPickupConfirm = { recoverable: true; primary: TicketRef } | { recoverable: false; reason: string };

/** §6 — the run is named so a confirm can only release the hold the operator was shown. */
export interface FlowConfirmRunPickupMsg {
  sessionId: SessionId;
  repoKey: string;
  run: RunIdentity;
  pr: number;
  ticket: number;
}

export type ConfirmRunPickupResult = { ok: true } | { ok: false; reason: string };

/** flow:onStateChanged broadcast (§24.2.2 S5): main signals that a flow-relevant input changed
 *  (a todo mutated, the agent flipped active/quiet); the strip re-pulls `flow:state`. Carries no
 *  payload beyond the session — the strip re-pulls for its own current repoKey (§16.3). */
export interface FlowStateChangedMsg {
  sessionId: SessionId;
}

/** flow:revealLoop push (§24.2.3 T4): main signals that the OS attention notification was activated
 *  and the loop read-out must be revealed. The renderer responds by exiting viewer-fullscreen if
 *  active, switching to the Terminal view, and opening the docked loop read-out. Window focus is a
 *  main-side effect; carries no payload beyond the session. */
export interface FlowRevealLoopMsg {
  sessionId: SessionId;
}

/** flow:onBootstrapError push (§27.10): main signals that a loop step's bootstrap could not proceed — an
 *  async in-app pickup that failed and rolled back to the previous step (revertStep), OR (AC 10) a declared
 *  `bootstrap` the bound def carries no contract for. The failure is never silent — the renderer raises a
 *  blocking error dialog carrying `reason` (the human-readable cause). `repoKey` and `step` name the failed
 *  resource, so a late push cannot be attributed to ambient flow state. */
export interface FlowBootstrapErrorMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  reason: string;
}

/** §6/§27.10. */
export interface FlowAppBootstrapConflictMsg extends AppBootstrapConflictTarget {
  sessionId: SessionId;
  repoKey: string;
  step: string;
}

/** §6/§27.10. */
export interface FlowResolveAppBootstrapConflictMsg
  extends AppBootstrapConflictTarget {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  wipe: boolean;
}

/** §6/§27.10 — the tickets a pull request closes, offered for the adopting run's primary. `choiceId` ties an answer
 *  to this offer alone. */
export interface FlowAdoptTicketChoiceMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  pr: number;
  choiceId: string;
  tickets: TicketRef[];
}

export type AdoptTicketOffer = Omit<FlowAdoptTicketChoiceMsg, 'sessionId'>;

export type AdoptTicketAnswer = { kind: 'ticket'; ticket: TicketRef } | { kind: 'cancel' };

/** §6/§27.10. */
export interface FlowResolveAdoptTicketMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  choiceId: string;
  answer: AdoptTicketAnswer;
}

export type ResolveAdoptTicketResult = { ok: true } | { ok: false; reason: string };

/** §6/§28.7 — the confirm-first preview naming every GitHub mutation the operator authorizes by confirming:
 *  the sub-tickets promotion will create, plus the epic tracking-issue edit and the epic PR close. `epic`/`pr`
 *  are the resource identities the renderer names (never re-derived — §6). */
export interface FlowEpicPromotionPreviewMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  epic: number;
  pr: number | null;
  subTickets: { index: number; title: string }[];
}

/** §6/§28.7 — the operator's answer to the confirm-first preview: `confirm` runs the promotion, otherwise it
 *  is declined and the gate is left as it was. */
export interface FlowResolveEpicPromotionMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  confirm: boolean;
}

/** flow:state/start/advance/restart request. `repoKey` scopes the flow to the terminal's current
 *  repo (§16.3), threaded like the todo channels so the flow follows the cwd (§6). */
export interface FlowRequestMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** flow:advance request: `step` is the step the strip showed (§27.9.1 N9b.5(e)); optional. */
export interface FlowAdvanceMsg extends FlowRequestMsg {
  step?: string;
}

/** flow:provideInput request (§18.4 / §24.2.3 T3 / §27.10): the renderer's answer to a step-entry
 *  `prompt`. `step` is the identity the prompt was raised for; a stale answer is inert rather than being
 *  applied to the flow's ambient current step. `values` maps each prompted input name to the user's typed
 *  value; main persists them and re-runs that step's entry action. */
export interface FlowProvideInputMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  values: Record<string, string>;
}

/** flow:setTitle request (§22.3.1): the name the user typed into the status bar for `repoKey`'s work. A
 *  blank `title` CLEARS the name. The name is bounded by TITLE_MAX and normalized by `normalizeTitle` —
 *  one predicate, shared with the on-disk store, so what the bar paints and what lands cannot disagree. */
export interface FlowSetTitleMsg {
  sessionId: SessionId;
  repoKey: string;
  title: string;
}

/** flow:setActiveFlow request (§18.7.2/§18.7.4): the catalog `id` the operator picked for `repoKey`'s
 *  worktree. Applied only while the run has never started (AC7). */
export interface FlowSetActiveFlowMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
}

/** flow:clearActiveFlow request (§18.7.2/§18.7.4): return `repoKey`'s worktree to the unset default. Gated like
 *  flow:setActiveFlow. */
export interface FlowClearActiveFlowMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** flow:setActiveFlow / flow:clearActiveFlow result (§18.7.4 AC7): the pointer was written or cleared, or the
 *  write was refused with a human-readable `reason` — the run has begun, begun-ness is indeterminate (fail-closed), or the write
 *  faulted. A refused write leaves the prior on-disk selection byte-for-byte unchanged (§18.7.2 AC8). */
export type ActiveFlowWriteResult = { ok: true } | { ok: false; reason: string };

/** §18.7.6 */
export interface FlowListCatalogMsg {
  sessionId: SessionId;
  repoKey: string;
}

export const CATALOG_ORIGINS = ['repo', 'global'] as const;
export type CatalogOrigin = (typeof CATALOG_ORIGINS)[number];

export type FlowCatalogEntry =
  | { available: true; id: string; origin: CatalogOrigin }
  | { available: false; label: string; origin: CatalogOrigin; reason: string };

/** §18.7.2/§18.7.3 — the worktree's active-flow pointer as the picker reflects it: no pick, a pick, or a set pick
 *  that cannot be used (which refuses the run, so it is never shown as the default). */
export type FlowCatalogSelection = { kind: 'unset' } | { kind: 'value'; id: string } | { kind: 'invalid' };

/** §18.1 / §18.7.6 */
export interface FlowCatalogListing {
  entries: FlowCatalogEntry[];
  tierNotices: { origin: CatalogOrigin; notice: string }[];
  selection: FlowCatalogSelection;
  /** Empty unless the worktree's run is held; otherwise every recovery choice, in the order the picker lists them. */
  recoveryOutcomes: RecoveryOutcomeOf[];
}

export type FlowCatalogListResult = { ok: true; listing: FlowCatalogListing } | { ok: false; reason: string };

/** §18.7.3 */
export type RebindChoice = { origin: 'local' } | { origin: CatalogOrigin; id: string } | { origin: 'fallback' };

/** §18.7.3 */
export type RecoveryOutcome = 'resumes' | 'ends';

export type RecoveryOutcomeOf =
  | { choice: RebindChoice; outcome: RecoveryOutcome }
  | { choice: RebindChoice; outcome: 'unavailable'; reason: string };

/** §18.7.3 / §6 — consent to end the run names the held step (as the flow view shows it) the operator confirmed
 *  ending, so the consent never ends a run held anywhere else. */
export type StepMissingConsent = 'refuse' | { endRunHeldAt: string };

/** §18.7.3 */
export type RebindResult =
  | { ok: true; outcome: 'resumed' }
  | { ok: true; outcome: 'terminated'; notice?: string }
  | { ok: false; reason: string };

/** §6 */
export interface FlowRebindHeldRunMsg {
  sessionId: SessionId;
  repoKey: string;
  choice: RebindChoice;
  ifStepMissing: StepMissingConsent;
}

/** The human's gate-decision option set the §27 gate owns (§27.9/§27.15): the option picked at a
 *  data-driven awaiting-human gate, mirroring the LoopDef `human_options` the gate offers. One runtime
 *  source (`GATE_DECISION_OPTIONS`) drives both the type and the §6 validator, so main, renderer, and the
 *  wire cannot drift on the set. The guard that a step never runs an option its bound def does not declare
 *  is enforced at the operation, validated against the def's declared options — never inferred from this
 *  type (AC9). */
export const GATE_DECISION_OPTIONS = ['approve', 'request-changes', 'impasse', 'redo', 'polish', 'back-to-red'] as const;
export type GateDecisionOption = (typeof GATE_DECISION_OPTIONS)[number];

/** The §27-only work-turn error route-out (§27.12c): the human recovers a stopped §27 work turn by
 *  re-running it (`retry`), accepting a present artifact without re-running (`accept`), or moving the flow
 *  off the step (`terminate`). ONE runtime source drives both the type and the §6 validator, so main,
 *  renderer, and the wire cannot drift on the set. Disjoint from `GATE_DECISION_OPTIONS` — a §27-only
 *  route-out concept (§27.15). */
export const APP_ROUTE_OUT_ACTIONS = ['retry', 'accept', 'terminate'] as const;
export type AppRouteOutAction = (typeof APP_ROUTE_OUT_ACTIONS)[number];

/** flow:appRouteOut request (§27.12c): the §27-only work-turn route-out. It carries the identity of the
 *  step and turn it acts on (§6) — the receiver acts on that identity, never ambient loop state — so a
 *  decision for one turn can never fire against another. One-way; the result surfaces through the §27 run
 *  state → flow:onStateChanged re-pull. */
export interface FlowAppRouteOutMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  action: AppRouteOutAction;
}

/** flow:appGateDecision request (§27.9/§27.13 / N5): the human's decision at a §27 (app-namespace) human
 *  gate. Like the §27 route-out it carries the identity of the `step` and `turnKey` it acts on (§6) — the
 *  receiver acts on that identity, never ambient loop state — so a decision for one gate can never fire
 *  against another (AC7). `option` is typed on the SHARED `GATE_DECISION_OPTIONS` set, so the wire, main,
 *  and renderer cannot drift; the guard that a step never runs an option its bound def does not declare is
 *  enforced at the operation, validated against the def's declared options — never inferred from this type
 *  (AC9). The reply is whether the decision landed; the result itself surfaces through the §27 run state →
 *  flow:onStateChanged re-pull. */
export interface FlowAppGateDecisionMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  option: GateDecisionOption;
}

/** flow:appRequestChanges request (§27.9/§19.4 / AC4): the operator's request-changes decision for `repoKey`,
 *  carrying the `step`+`turnKey` identity it acts on (§6) and the composed `feedback` delivered into the next
 *  review-and-fix round. The reply is whether the round started,
 *  so the feedback composer holds open until delivery confirms and never discards the human's input on a drop. */
export interface FlowAppRequestChangesMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  feedback: string;
}

/** flow:appRedo request (§27.9/AC5): the operator's redo decision for `repoKey`, carrying the `step`+`turnKey`
 *  identity it acts on (§6) and the human `instruction` that re-enters the work turn on a clean slate (only the
 *  ticket, the plan, and that instruction — no findings, no round history). Two-way like appRequestChanges: the reply is whether the work turn re-entered, so the redo composer holds open
 *  until it confirms and never discards the human's instruction on a drop (runner mid-turn / gate raced out). */
export interface FlowAppRedoMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  instruction: string;
}

/** flow:appBackToRed request (§28.4.2): the operator's back-to-red decision for `repoKey`, carrying the
 *  `step`+`turnKey` identity it acts on (§6) and the `brief` the turns that read it are handed (empty = a plain
 *  reopen). Two-way like appRedo: the reply is whether the flow is back at its return step, so the composer holds
 *  open and keeps the brief when the reopen does not land. */
export interface FlowAppBackToRedMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  brief: string;
}

/** flow:armInterrupt request (§27.9/AC9): the operator arms the queued interrupt for a §27 loop step. It
 *  carries the identity of the `step` it acts on (§6) — the receiver arms that step's interrupt, never one
 *  derived from ambient state — so an arm for one step can never fire against another. One-way; the consolidator
 *  honors it at its next invocation (routing to the gate) and the panel re-pulls via flow:onStateChanged. */
export interface FlowArmInterruptMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
}

/** flow:githubRef request (§24.2.3 T7): resolve a ref's title/body/url for the popout. `repoKey`
 *  scopes the `gh` lookup to the right repo; `number` is the issue/PR number; `kind` selects which. */
export interface FlowGithubRefMsg {
  sessionId: SessionId;
  repoKey: string;
  kind: GithubRefKind;
  number: number;
}

/** app:openExternal request (§24.2.3 T7): open a ref's GitHub `url` in the OS browser. Main validates
 *  the url (https + a GitHub host) before handing it to the OS — the renderer cannot open arbitrary
 *  schemes (CWE-601 open-redirect / local-scheme abuse). */
export interface AppOpenExternalMsg {
  sessionId: SessionId;
  url: string;
}

/** Flow lifecycle (§24.2.2): drive the manual step's status strip + control. Each call
 *  resolves to the resulting state so the strip re-renders from the response. */
export interface FlowApi {
  state(repoKey: string): Promise<FlowStateView>;
  /** not_started → in_progress; rejects if not currently not_started. */
  start(repoKey: string): Promise<FlowStateView>;
  /** in_progress → done; rejects if not currently in_progress. `step`, when given, names the step the caller
   *  showed: an Advance naming a step the flow has left advances nothing (§27.9.1 N9b.5(e), §6). */
  advance(repoKey: string, step?: string): Promise<FlowStateView>;
  /** done → in_progress; resets and re-runs the first step. Rejects if not currently done. */
  restart(repoKey: string): Promise<FlowStateView>;
  /** done → in_progress; reverts a manual advance WITHOUT re-running the step's entry actions
   *  (unlike restart). Rejects if not currently done. */
  undo(repoKey: string): Promise<FlowStateView>;
  /** in_progress|done → not_started (#26): abandons the flow, discarding carried-over inputs, and
   *  resolves to the reset (not_started) view. Inert from not_started / load-error. Main also clears
   *  the repo's todos, the global capture tab, and finalizes the audit run as one user-confirmed action. */
  terminate(repoKey: string): Promise<FlowStateView>;
  /** Answer a step-entry input `prompt` (§18.4 / §24.2.3 T3): persist the typed `values` only while
   *  `step` is still current, then re-run its entry action and return the new view. */
  provideInput(repoKey: string, step: string, values: Record<string, string>): Promise<FlowStateView>;
  /** Name the repo's work, or clear the name with a blank (§22.3.1). Resolves to the new view; unlike the
   *  other flow:* calls, an unsafe or unregistered-repo target REJECTS rather than resolving to a benign
   *  error view (§22.3.1). */
  setTitle(repoKey: string, title: string): Promise<FlowStateView>;
  /** Select the worktree's active flow (§18.7.2/§18.7.4). Permitted only while the run has never started;
   *  once it has begun — or while begun-ness cannot be verified — the write is refused with a reason (AC7).
   *  A3's picker mirrors this in its enable state, but this is the authoritative main-side gate. */
  setActiveFlow(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  /** Return the worktree to the unset default flow; gated exactly like `setActiveFlow`. */
  clearActiveFlow(repoKey: string): Promise<ActiveFlowWriteResult>;
  /** §18.7.6 */
  listCatalog(repoKey: string): Promise<FlowCatalogListResult>;
  /** §18.7.3 */
  rebindHeldRun(repoKey: string, choice: RebindChoice, ifStepMissing: StepMissingConsent): Promise<RebindResult>;
  /** §27.13 */
  confirmRunPickup(repoKey: string, run: RunIdentity, pr: number, ticket: number): Promise<ConfirmRunPickupResult>;
  /** Subscribe to main's flow:onStateChanged push (§24.2.2 S5): `cb` fires when a flow-relevant
   *  input changed (todo/activity), prompting a `state()` re-pull. Returns an unsubscribe. */
  onStateChanged(cb: () => void): () => void;
  /** Subscribe to main's flow:revealLoop push (§24.2.3 T4): `cb` fires when the OS attention
   *  notification was activated and the loop read-out must be revealed. Returns an unsubscribe. */
  onRevealLoop(cb: () => void): () => void;
  /** Subscribe to main's flow:onBootstrapError push (§27.10): `cb` fires with the human-readable `reason`
   *  and the failed repo/step identity when a loop step's bootstrap could not proceed (an async pickup that
   *  rolled back, or a declared bootstrap the bound def has no contract for); the renderer raises a blocking
   *  error dialog. Returns an unsubscribe. */
  onBootstrapError(cb: (reason: string, repoKey: string, step: string) => void): () => void;
  /** §6/§27.10. */
  onAppBootstrapConflict(
    cb: (
      conflict: AppBootstrapConflictTarget & { repoKey: string; step: string },
    ) => void,
  ): () => void;
  /** §6/§27.10. */
  resolveAppBootstrapConflict(
    repoKey: string,
    step: string,
    wipe: boolean,
    target: AppBootstrapConflictTarget,
  ): void;
  /** §6/§27.10. */
  onAdoptTicketChoice(cb: (offer: AdoptTicketOffer) => void): () => void;
  /** §6/§27.10. */
  resolveAdoptTicket(repoKey: string, step: string, choiceId: string, answer: AdoptTicketAnswer): Promise<ResolveAdoptTicketResult>;
  /** §6/§28.7 — subscribe to the epic-promotion confirm-first preview (main → renderer). Returns unsubscribe. */
  onEpicPromotionPreview(
    cb: (preview: { repoKey: string; step: string; epic: number; pr: number | null; subTickets: { index: number; title: string }[] }) => void,
  ): () => void;
  /** §6/§28.7 — answer the confirm-first preview (renderer → main): confirm runs the promotion, else decline. */
  resolveEpicPromotion(repoKey: string, step: string, confirm: boolean): void;
  /** Resolve a GitHub ref's title/body/url for the popout (§24.2.3 T7), best-effort: null when it
   *  can't be resolved (no `gh`, not a GitHub repo, offline) so the popout shows the number alone. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  /** Open a ref's GitHub `url` in the OS browser (§24.2.3 T7); resolves to whether it was opened
   *  (false when main rejects the url as non-GitHub/non-https). */
  openExternal(url: string): Promise<boolean>;
  /** §27.12c — the §27-only work-turn route-out for `repoKey`, carrying the `step`+`turnKey` identity it
   *  acts on (§6). `retry` re-runs the turn, `accept` advances a present artifact without re-running,
   *  `terminate` moves the flow off the step. One-way: the loop panel re-pulls via flow:onStateChanged. */
  appRouteOut(repoKey: string, step: string, turnKey: string, action: AppRouteOutAction): void;
  /** §27.9/§27.13 (N5) — submit the human's §27 gate decision for `repoKey`, carrying the `step`+`turnKey`
   *  identity it acts on (§6). `approve` runs the bound loop's declared side-effect out of band and reaches
   *  the terminal accept; a legacy step never fires this path (AC8) and an option the bound def does not
   *  declare is rejected at the operation (AC9). Resolves whether the decision landed once main has finished
   *  acting on it, so the gate's controls hold until then; the panel still re-pulls via flow:onStateChanged. */
  appGateDecision(repoKey: string, step: string, turnKey: string, option: GateDecisionOption): Promise<boolean>;
  /** §27.9/§19.4 (AC4) — submit a request-changes decision for `repoKey`, carrying the `step`+`turnKey` identity
   *  (§6) and the composed `feedback` for the next review-and-fix round. Resolves whether the round started, so
   *  the feedback composer holds open until delivery confirms — a drop (runner mid-turn / gate raced out) never
   *  discards the human's input. */
  appRequestChanges(repoKey: string, step: string, turnKey: string, feedback: string): Promise<boolean>;
  /** §27.9/AC5 — submit a redo decision for `repoKey`, carrying the `step`+`turnKey` identity (§6) and the human
   *  `instruction` that re-enters the work turn on a clean slate (ticket + plan + instruction only). Resolves
   *  whether the work turn re-entered, so the redo composer holds open until it confirms — a drop (runner
   *  mid-turn / gate raced out) never discards the human's instruction. */
  appRedo(repoKey: string, step: string, turnKey: string, instruction: string): Promise<boolean>;
  /** §28.4.2 — send `repoKey`'s flow back to its return step from the gate at `step`+`turnKey` (§6), carrying the
   *  `brief` the turns that read it are handed (empty = a plain reopen). Resolves whether the flow is
   *  back at that step, so the composer holds open and keeps the brief when it is not. */
  appBackToRed(repoKey: string, step: string, turnKey: string, brief: string): Promise<boolean>;
  /** §27.9/AC9 — arm the queued interrupt for `repoKey`'s §27 loop `step` (the identity it acts on, §6). The
   *  consolidator honors it at its next invocation, routing to the human gate. One-way: the loop panel
   *  re-pulls via flow:onStateChanged when the resulting state lands. */
  armInterrupt(repoKey: string, step: string): void;
}
