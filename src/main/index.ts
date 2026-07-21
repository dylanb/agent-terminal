import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, shell } from 'electron';
import { applyApplicationMenu, buildMenuTemplate } from './appMenu';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  CH,
  SESSION_ID,
  type AgentState,
  type ChannelPayloads,
  type FlowStateView,
  type GateDecisionOption,
  type GithubRef,
  type SendChannel,
  type TodoStatus,
} from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createMonitorEventsFile } from './monitorEventsFile';
import { createShadowModel } from './shadow';
import { spawnAgentShell, resolveShellPath } from './pty';
import { createPtyIo } from './ptyIo';
import { shouldTerminateOnShellExit } from './shellExit';
import { disposeAll } from './windowTeardown';
import { resolveLaunchSurfaces } from './launchRoot';
import { createOutputGate } from './outputGate';
import { resolveRendererTarget } from './rendererTarget';
import { installNavigationGuards } from './windowGuards';
import {
  isValidCapture,
  isValidCaptureLast,
  isValidDismiss,
  isValidDismissAll,
  isValidFlowRequest,
  isValidFlowProvideInput,
  isValidFlowSetTitle,
  isValidFlowGateDecision,
  isValidFlowResolveBootstrapConflict,
  isValidFlowAppRouteOut,
  isValidFlowAppGateDecision,
  isValidFlowAppRequestChanges,
  isValidFlowAppRedo,
  isValidFlowArmInterrupt,
  isValidFlowGithubRef,
  openExternalTarget,
  isValidInject,
  isValidClipboardWrite,
  isValidInput,
  isValidLearnChrome,
  isValidResize,
  isValidSetSettings,
  isValidTemplateInstantiate,
  isValidTemplateList,
  isValidTodoAdd,
  isValidTodoDelete,
  isValidTodoList,
  isValidTodoReorder,
  isValidTodoSetStatus,
  isValidTodoUpdate,
  isValidViewerRead,
  isValidViewerTree,
} from './ipcValidation';
import { createTodoStore } from './todoStore';
import { createUiSettingsStore } from './uiSettings';
import { registerIpcListeners } from './sessionIpc';
import { resolveRuntimeConfig } from './runtimeConfig';
import { createCommandTracker } from './commandTracker';
import { createCwdTracker } from './cwdTracker';
import { currentRepoInfo, resolveRepoKey } from './repoKey';
import { createScanner } from './scanner';
import { captureLastReport } from './captureLast';
import { createFlowManager, deriveFlowView, legacyLoopNameForStep, loadFlowDefinitionLocalFirst } from './flow';
import { createGithubRefs } from './githubRefs';
import { createAuditRecorder } from './auditRecorder';
import type { TransitionKind } from '../shared/audit';
import { auditRootDir } from './auditPaths';
import { createFlowEntryActions } from './flowEntryActions';
import { planStepResume } from './loopRebind';
import { parseAgentLoopState, watchAgentLoopState } from './agentLoopBridge';
import { createLoopNotifier } from './loopNotifier';
import { parseLoopDef, gateForStatus, reviewerRosterForPhase, normalizeConsolidatedVerdict, isPersonaClean, artifactPath, loopExecAllowed, type LoopDef, type PickupContract } from './loopDef';
import { runPickup, createRealPickupDeps, decidePickupAction } from './loopPickup';
import { classifyHostedAgent, createTurnRunner, decideConsolidateOutcome, hostedAgentPresent, type TurnRunner } from './loopOrchestrator';
import { deriveLoopActivity, type LoopActivity } from '../shared/loopActivity';
import { composeWorkPrompt, composeSpawnReviewersPrompt, composeConsolidatePrompt } from './loopRecipe';
import { allReviewsPresent, anyReviewPresent, consolidatedVerdict, consolidatedFindings, personaVerdict, carryForwardReviews, planDigest } from './reviewArtifacts';
import { findingSignature, nextImpasse } from './findingSignature';
import { readSessionTokens, sessionLogDir } from './costMeter';
import { createFlowStateStore } from './flowState';
import { createRealCiChecks } from './ciChecks';
import { priceTokens, formatCost, type CostResult } from '../shared/pricing';
import { prunablePersonas, recordCleanPersonas } from './personaSkip';
import { decideGateOutcome, shouldAdvanceFlowOnGate, type GateOption } from './gateActions';
import { executeGateOutcome } from './gateExecutor';
import { createRealGateGitHub } from './gateGithub';
import { createRealGateExec } from './gateExec';
import { writeHumanNote } from './humanNotes';
import { readEpicPlan } from './epicPlan';
import { readTurnDone, clearTurnDone, watchTurnDone } from './turnDoneFile';
import { writeLoopState } from './loopStateWriter';
import { readLoopExtension } from './loopStateReader';
import { canResumeRepo, currentTurnByArtifacts, decideResume, shouldReconstructErrorTurn } from './loopResume';
import type { FlowStepDef } from './flow';
import { listTodoTemplates, loadTodoTemplateFile, parseTodoTemplate, todoTemplatesDir } from './todoTemplate';
import { discover, readArtifact, emptyTree, warmBaseRef, createBaseWarmer, createViewerActivityHandler, gitRootOf } from './artifactTree';
import { watchViewerTree, viewerRoot } from './viewerWatch';
import { createChromeProfileStore } from './chromeProfile';
import { learnMarkers } from './chrome';
import { createInjectionSuppressor } from './injectionSuppression';
import { createClaudeCodeAdapter } from './adapters/claudeCode';
import { createGenericAdapter } from './adapters/generic';
import { SHELL_INTEGRATION_SCRIPT } from './shellIntegration';
import { resolveWindowIconPath, applyDockIcon } from './appIcon';
import { handleCliInstall } from './cliInstall';
import { resolveLaunchInvocation } from './cliShim';
import type { BundleLocation } from './bundleLocation';
import {
  exampleInstallDirs,
  handleInstallExamplesPreview,
  handleInstallExamplesApply,
  type InstallDestination,
} from './installExamples';
import { provideAppLoopView } from './loopViewV2';
import { createAppLoopEngine } from './appLoopEngine';
import { APP_LOOP_DIR_SEGMENTS, armInterrupt, clearPolish, consolidatorOutputFile, consolidatorOutputRel, enterPolish, readAppLoopState, readPolish, roundReportFile, roundReportRel, writeAppLoopState } from './appLoopState';
import { resolveLoopDefV2, type LoopDefV2Context } from './loopDefV2';
import { createRealAppGateGitHub } from './appGateGithub';
import { runAppGateDecision as runAppGateDecisionImpl } from './appGateDecision';
import { completionArtifact } from './appWorkTurn';
import { resolveExampleLoopsV2Dir } from './exampleAssets';
import { userConfigLoopsV2Dir } from './userConfig';
import type { CliInstallResult } from '../shared/ipc';

async function createWindow(): Promise<void> {
  const iconLoc: BundleLocation = app.isPackaged
    ? { packaged: true, resourcesPath: process.resourcesPath }
    : { packaged: false, appPath: app.getAppPath() };
  // TODO(dylan): Electron exposes no getIcon() and app.dock is macOS-only, so neither the
  // BrowserWindow.icon assignment below nor applyDockIcon has a Linux e2e — resolveWindowIconPath and
  // applyDockIcon are unit-covered. Recorded gap.
  applyDockIcon(app.dock, process.platform, iconLoc);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: resolveWindowIconPath(iconLoc),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The preload exposes PTY-writing APIs, so the window must never navigate off the bundled renderer
  // or open child windows (§6, security checklist) — either would hand those APIs to foreign content.
  installNavigationGuards(win.webContents);

  const config = resolveRuntimeConfig(process.env);
  // §23.4: L anchors the cwd surfaces; the flow global dir is the per-user home (§18.1), not L.
  const { launchRoot, flowGlobalDir } = resolveLaunchSurfaces(process.env, os.homedir());
  // §18.1/§23.4/§26.5: the install-examples action's bundle sources (build-aware) + its install targets
  // (the GLOBAL flow home and the user-level Claude config directories). The handlers read this seam.
  const exampleDirs = (): InstallDestination[] => exampleInstallDirs(iconLoc, flowGlobalDir);
  const ptyProcess = await spawnAgentShell({
    integrationScriptPath: config.shellIntegration ? SHELL_INTEGRATION_SCRIPT : undefined,
    cwd: launchRoot,
  });
  const shellSpawnedAt = performance.now(); // monotonic: a wall-clock jump must not flip the grace
  // PTY I/O after the shell exits is dropped, not driven into a dead master fd (§5; ptyIo.ts).
  const ptyIo = createPtyIo(ptyProcess);
  // §8.4
  const store = createMonitorEventStore({ persistence: createMonitorEventsFile(launchRoot) });
  // §16.6: the only state that lives outside the repo (userData).
  const uiSettings = createUiSettingsStore(path.join(app.getPath('userData'), 'ui-settings.json'));
  const todoStore = createTodoStore({ maxDoneTodos: config.maxDoneTodos });
  const chromeProfile = createChromeProfileStore(path.join(app.getPath('userData'), 'chrome-profile.json'));
  // Fail a malformed flow request closed to an inert error view rather than throwing across IPC.
  const flowRequestError = (): FlowStateView => ({
    stepName: '',
    steps: [],
    position: 0,
    total: 0,
    status: 'error',
    error: 'invalid flow request',
  });

  const send = <C extends SendChannel>(channel: C, payload: ChannelPayloads[C]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // macOS Edit menu (§7.7): route ⌘C/⌘V/⌘A to our renderer actions so they don't operate on xterm's
  // hidden native selection. Off darwin a minimal menu (keyboard zoom + fullscreen) is installed
  // instead — replacing Electron's default menu so its ⌘0 "Reset Zoom" can't preempt openSettings (§7.7).
  // TODO(keymap): the menu-accelerator→IPC dispatch is macOS-only, so it has no Linux e2e; the pure
  // template + install logic (appMenu.test) and the renderer router (menuActions.test) are unit/DOM covered.
  applyApplicationMenu(buildMenuTemplate(process.platform, (action) => send(CH.menuEdit, { action })), Menu);

  // S5 (§24.2.2): the flow's derived in-progress status (n/m done + agent activity) is PUSHED to
  // the strip — main fires flow:onStateChanged on any flow-relevant change (a todo mutated, the
  // agent flipped active/quiet) and the strip re-pulls flow:state. `agentActivity` holds the latest
  // §8.3 activity so flow:state can fold it into the derived view without re-deriving it.
  let agentActivity: AgentState = 'quiet';
  // §26.2/§26.3 — fired on each active→quiet flip so the loop orchestrator can inject a deferred/retry
  // turn the moment the instance is injectable. Assigned once the runner exists (below); a no-op until.
  let notifyInjectable: () => void = () => {};
  const pushFlowChanged = (): void => send(CH.flowOnStateChanged, { sessionId: SESSION_ID });

  // Hold early PTY output until the renderer registers its pty:data listener (§8.1).
  const outputGate = createOutputGate((data) => send(CH.ptyData, { sessionId: SESSION_ID, data }));

  const shadow = createShadowModel({
    quietMs: config.quietMs,
    onStatus: (status) => {
      agentActivity = status.agentState;
      send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status });
      pushFlowChanged(); // the active↔quiet flip moves the strip's derived activity (§24.2.2 S5)
      if (status.agentState === 'quiet') notifyInjectable(); // §26.2: the instance is now injectable
    },
  });

  // Capture (§15.5) + scanner (§15.2/§15.3) read only the shadow's public path: detection, no autonomy.
  const tracker = createCommandTracker({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    onOsc: (id, cb) => shadow.onOsc(id, cb),
    config,
  });
  // §26.2 presence (hostedAgentPresent) is derived from the live OSC-133 spans; the classification lives
  // in loopOrchestrator so the leak-prevention gate is unit-tested away from this composition root.
  // §16.3: broadcast only on repo-key change, so the pane swaps its todo list once per `cd` across a
  // repo boundary rather than on every cwd move.
  // TODO(dylan): the full OSC-7 → cwd:changed → repo-list-swap loop through real
  // node-pty + bash is verified in the §F e2e (plan PR5 5c) — recorded gap.
  const cwdTracker = createCwdTracker({ onOsc: (id, cb) => shadow.onOsc(id, cb) });
  const knownRepoKeys = new Set([resolveRepoKey(launchRoot)]);
  // Before the first OSC 7, fall back to bash's spawn dir — never the Electron process dir — so the
  // viewer starts in sync with the shell (§20.1).
  const viewerCwd = (): string => cwdTracker.cwd() ?? launchRoot;
  // Live artifact reload (§20.1): watch the viewer's tree root so an on-disk edit re-broadcasts over a
  // dedicated viewer:onChanged seam (the renderer re-pulls tree/file). One watcher, re-rooted on each
  // cwd move — the tree root follows the shell like discovery does.
  const pushViewerChanged = (): void => send(CH.viewerOnChanged, { sessionId: SESSION_ID });
  // §20.1: discovery resolves the base from local refs synchronously; the real gh PR base is refined
  // off-thread here and re-pulls the viewer when it differs. Warm on each watch burst too — a `git
  // checkout` produces no cwd change, so its working-tree writes are the only signal a branch switched;
  // warmBaseRef is deduped per (root, branch) so repeat bursts never re-spawn gh. TODO(dylan): the
  // gh-driven refresh is unprovokable in e2e (no live PR in CI) — warmBaseRef + createBaseWarmer are
  // unit-covered; recorded gap.
  const warmBase = createBaseWarmer({
    root: () => gitRootOf(viewerCwd()),
    warm: (root) => warmBaseRef(root),
    onChanged: pushViewerChanged,
  });
  const onViewerActivity = createViewerActivityHandler({ pushChanged: pushViewerChanged, warm: warmBase });
  let stopViewerWatch = watchViewerTree(viewerRoot(viewerCwd()), onViewerActivity);
  void warmBase();
  cwdTracker.onChange(({ cwd, repoKey }) => {
    knownRepoKeys.add(repoKey);
    send(CH.cwdChanged, { sessionId: SESSION_ID, cwd, repoKey });
    stopViewerWatch();
    stopViewerWatch = watchViewerTree(viewerRoot(cwd), onViewerActivity);
    void warmBase();
    // §26.11 / §26 D42a — resume/reconstruct the run in the repo the operator just entered, not only the
    // launch root: cd-ing into a repo whose run is stranded in `error` (or mid-work) must reconstruct its
    // turn so the loop panel's Retry / mark-turn-complete act on it. Keyed to `repoKey` — the same identity
    // the flow + the recovery handlers use — so the reconstructed activeTurn.repoDir matches. Idempotent
    // (guarded on activeTurn/resumedRepos); the error path injects nothing, and a mid-work drive that finds
    // no hosted agent safe-stops (§26.2) rather than leaking into a bare shell.
    resumeLoop(repoKey);
  });
  // Drops echoed self-injected input from re-capture (§16.5).
  // TODO(dylan): the watermark→reply row separation and selfInjectWindowMs default
  // are tuned against bash/scripted echo; verify against a real Claude Code
  // `[Pasted text]` placeholder + reply in the §F e2e (plan PR5) — recorded gap.
  const suppressor = createInjectionSuppressor({
    cursorRow: () => shadow.reader.cursor().y,
    addMarker: (r) => shadow.addMarker(r),
    windowMs: config.selfInjectWindowMs,
  });
  const scanner = createScanner({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    // No onQuiet ⇒ capture is manual via capture:last only (§21.1): the scanner never auto-emits, so
    // emit/remove below stay wired for the dormant streaming path but never fire here.
    adapters: config.adapterEnabled('claude-code') ? [createClaudeCodeAdapter()] : [],
    baseline: createGenericAdapter(),
    dedupRetention: config.dedupRetention,
    reportMinChars: config.reportMinChars,
    closedSpans: () => tracker.closedSpans(),
    isSuppressed: (region) => suppressor.isSuppressed(region),
    chromeMarkers: () => chromeProfile.markers(),
    commandTexts: () => tracker.summaries().map((s) => s.command),
    emit: (e) => {
      const event = store.addEvent({
        sessionId: SESSION_ID,
        type: e.type,
        source: e.source,
        text: e.text,
        range: e.range,
        parentId: e.parentId,
        truncated: e.truncated,
      });
      send(CH.monitorEvent, { sessionId: SESSION_ID, event });
      return event.id;
    },
    // Retraction (§15.3): a later scan superseded a partial capture — drop it from the store so
    // replay won't resurrect it (cascading to its findings), and tell the pane to remove the block.
    remove: (id) => {
      store.remove(id);
      send(CH.monitorEventRemoved, { sessionId: SESSION_ID, eventId: id });
    },
  });

  const inject = createInjector({
    write: (data) => ptyIo.io.write(data),
    isBracketedPaste: () => shadow.isBracketedPaste(),
    onInject: () => suppressor.noteInjection(),
  });

  // §26.3/§26.4 — the in-app turn descriptor the runner's domain ports read. A turn is the `work` actor
  // (produces `plan.md`), the `reviewers` fan-out (produces every roster persona's
  // `reviews/<iter>/<persona>.json`), or the `consolidate` actor (produces `reviews/<iter>/consolidated.json`
  // with a verdict); `kind` selects the prompt recipe and the artifact-confirmed check.
  type ActiveTurn =
    | { kind: 'work'; repoDir: string; loopName: string; phase: string; turnKey: string }
    | { kind: 'reviewers'; repoDir: string; loopName: string; phase: string; turnKey: string; personas: string[]; iteration: number }
    | { kind: 'consolidate'; repoDir: string; loopName: string; phase: string; turnKey: string; iteration: number };
  let activeTurn: ActiveTurn | null = null;
  // §26 activity readout — an in-flight bootstrap (before state.yaml exists), and whether the current
  // turn's PROMPT has been injected yet (deferred → "waiting", injected → the turn phrase). Both feed the
  // status bar's activity via deriveLoopActivity; neither is authority, only display.
  let pickupInFlight: { repoKey: string; issue: number; wipe: boolean } | null = null;
  let turnPromptInjected = false;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let unwatchTurnDone: (() => void) | null = null;
  let turnRunner: TurnRunner;
  // §26.3/D47a(b) — whether a turn's expected artifact exists and parses. Standalone (not just the runner's
  // dep) so the §26.3/D48 error-recovery "accept" path can gate on the SAME check the runner uses.
  const artifactPresentFor = (turn: ActiveTurn): boolean => {
    if (turn.kind === 'reviewers') return allReviewsPresent(turn.repoDir, turn.iteration, turn.personas);
    if (turn.kind === 'consolidate') return consolidatedVerdict(turn.repoDir, turn.iteration) !== null;
    // §26.3/D47a — the WORK turn's completion artifact comes from the loop (`def.workArtifact`), the SAME
    // definition the injected instruction names, so the runner's gate and the agent's instruction can't
    // desync. "" (impl-loop: work produces code, not a file) → no file gate; completion is the turn-done
    // file alone (the runner still requires onDoneSignal). Non-empty (plan-loop) → the file must be present.
    const rel = parseLoopDef(turn.repoDir, turn.loopName)?.workArtifact ?? '';
    if (rel === '') return true;
    try {
      return statSync(path.join(turn.repoDir, rel)).size > 0;
    } catch {
      return false;
    }
  };
  turnRunner = createTurnRunner({
    compose: () => {
      if (!activeTurn) return null;
      if (activeTurn.kind === 'reviewers') {
        return composeSpawnReviewersPrompt({
          phase: activeTurn.phase,
          iteration: activeTurn.iteration,
          personas: activeTurn.personas,
          turnKey: activeTurn.turnKey,
        });
      }
      if (activeTurn.kind === 'consolidate') {
        return composeConsolidatePrompt({
          repoDir: activeTurn.repoDir,
          loopName: activeTurn.loopName,
          phase: activeTurn.phase,
          iteration: activeTurn.iteration,
          turnKey: activeTurn.turnKey,
          // §26.5 — v1 omits the rising severity-floor ladder (severity_floor_track read, not enforced),
          // so the clean policy is "keep-nothing → clean" and the floor is `minor` (defers nothing).
          tokens: {
            CLEAN_POLICY: 'Emit verdict "clean" only when findings_kept is empty after triage; otherwise "needs-work".',
            SEVERITY_FLOOR: 'minor',
          },
        });
      }
      const s = parseAgentLoopState(activeTurn.repoDir);
      return composeWorkPrompt({
        repoDir: activeTurn.repoDir,
        loopName: activeTurn.loopName,
        phase: activeTurn.phase,
        turnKey: activeTurn.turnKey,
        // §26.3/D47a — the same `def.workArtifact` the runner's gate uses (artifactPresentFor), so the
        // injected "verify before done" instruction and the completion check name the same file (or none).
        workArtifact: parseLoopDef(activeTurn.repoDir, activeTurn.loopName)?.workArtifact ?? '',
        tokens: {
          ITERATION: String(s?.iteration ?? 1),
          PR_NUMBER: s?.pr != null ? String(s.pr) : '',
          HEAD_REF: s?.branch ?? '',
          PLAN_LINE_THRESHOLD: '1000',
        },
      });
    },
    inject: (prompt, opts) => {
      // §26.3/D46 — clearing the prior turn's done-signal any earlier than the next turn's PROMPT inject
      // would drop a completion that arrived during the transition.
      if (!opts?.preamble && activeTurn) {
        clearTurnDone(activeTurn.repoDir);
        // §26 activity — the turn prompt landing flips the strip readout from "Waiting for the agent" to
        // the turn phrase (the preamble keeps the wait phrase; it is not the turn working yet).
        turnPromptInjected = true;
        pushFlowChanged();
      }
      inject(prompt, { submit: true });
    },
    hostedAgent: () => classifyHostedAgent(hostedAgentPresent(tracker.summaries()), agentActivity),
    artifactPresent: () => (activeTurn ? artifactPresentFor(activeTurn) : false),
    armTimer: () => {
      if (turnTimer) clearTimeout(turnTimer); // self-clearing: a re-arm (each activity edge) replaces, never leaks
      turnTimer = setTimeout(() => turnRunner.onStall(), config.stallTimeoutMs);
    },
    cancelTimer: () => {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
    },
    writeError: (reason) => {
      if (!activeTurn) return;
      const s = parseAgentLoopState(activeTurn.repoDir);
      writeLoopState(activeTurn.repoDir, {
        status: 'error',
        iteration: s?.iteration ?? 1,
        pr: s?.pr ?? null,
        branch: s?.branch ?? null,
        boundLoop: activeTurn.loopName,
        linkedIssues: s?.linkedIssues ?? [],
        errorReason: reason,
      });
      audit.recordCommand(activeTurn.repoDir, 'turn', `turn ${activeTurn.turnKey} failed: ${reason}`, 1);
      pushFlowChanged();
      // §26.3/D48 — a live turn-runner failure is never silent: raise the blocking error dialog with the
      // reason (the panel's error pill + Retry stay; the dialog only informs). Only fires on a fresh
      // transition into error — resume/reconstruction (§26.11) rebuilds activeTurn without driving writeError.
      send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason });
    },
    onComplete: (turnKey) => {
      const finished = activeTurn;
      if (finished) audit.recordCommand(finished.repoDir, 'turn', `turn ${turnKey} complete`, 0);
      pushFlowChanged();
      chainAfter(finished);
    },
    // §26.3/D46 — re-arm the shadow quiescence window so a chained turn waits for a fresh active→quiet
    // edge before injecting, rather than racing the still-streaming agent on the stale post-done-signal quiet.
    noteSettle: () => shadow.noteSettle(),
  });
  // §26.4/§26.6 — the turn→next-turn chain a completed turn advances into. One definition shared by the
  // automatic completion path (onComplete) and the §26.3/D48 recovery "accept" path (markTurnComplete),
  // so a human-accepted turn advances through the exact same steps a signalled one would.
  const chainAfter = (finished: ActiveTurn | null): void => {
    // §26.4 — the work turn chains into the reviewer fan-out (same loop, same iteration).
    if (finished?.kind === 'work') startReviewersTurn(finished.repoDir, finished.loopName, finished.phase);
    // §26.3/D46 — the fan-out chains into the consolidate turn, /clear-ing the instance first so the
    // consolidator merges in a fresh main-instance context (the work-agent's context cannot bias it).
    else if (finished?.kind === 'reviewers') {
      startConsolidateTurn(finished.repoDir, finished.loopName, finished.phase, finished.iteration, CLEAR_PREAMBLE);
    }
    // §26.6 — the consolidate verdict decides the branch (clean STOPs at the gate, needs-work re-iterates).
    else if (finished?.kind === 'consolidate') advanceAfterConsolidate(finished);
  };
  // §27.15 — the §27 (app-namespace) work-turn engine, driving the SAME hosted instance as the §26 runner
  // through its own domain ports. Only one turn is ever in flight (one instance), so the shadow signals fan
  // out to BOTH runners below; the idle one no-ops (each guards on its own in-flight state). The §27 engine
  // keeps its run state and done-file in the §27 loop area, disjoint from §26's `.agent-loop/` (AC10).
  const appTurnDoneSubdir = path.join(...APP_LOOP_DIR_SEGMENTS);
  let appTurnTimer: ReturnType<typeof setTimeout> | null = null;
  let unwatchAppTurnDone: (() => void) | null = null;
  // §27.15 — one def-resolution context shared by the engine's resolveDef and the §27 gate executor, so both
  // resolve the same def from the same tiers.
  const appDefContext = (repoDir: string): LoopDefV2Context => ({
    tiers: { operator: userConfigLoopsV2Dir(), appBundled: resolveExampleLoopsV2Dir(iconLoc) },
    repoDir,
  });
  const appEngine = createAppLoopEngine({
    inject: (text) => inject(text, { submit: true }),
    // §27.9/AC6 — the polish stand-down is app-owned loop state in its own file; the engine consults it before
    // running any lever that would re-enter a turn, so the orchestrator stands down until approve ends it.
    polishActive: (repoDir) => readPolish(repoDir) !== null,
    hostedAgent: () => classifyHostedAgent(hostedAgentPresent(tracker.summaries()), agentActivity),
    armTimer: () => {
      if (appTurnTimer) clearTimeout(appTurnTimer); // self-clearing: each activity edge replaces, never leaks
      appTurnTimer = setTimeout(() => appEngine.onStall(), config.stallTimeoutMs);
    },
    cancelTimer: () => {
      if (appTurnTimer) clearTimeout(appTurnTimer);
      appTurnTimer = null;
    },
    noteSettle: () => shadow.noteSettle(),
    resolveDef: (repoDir, name) => resolveLoopDefV2(name, appDefContext(repoDir)),
    readRecipe: (absPath) => {
      try {
        return readFileSync(absPath, 'utf8');
      } catch {
        return null;
      }
    },
    readArtifact: (absPath) => {
      try {
        return readFileSync(absPath, 'utf8');
      } catch {
        return null;
      }
    },
    persist: (repoDir, state) => writeAppLoopState(repoDir, state),
    // §27.5 — the round-keyed report location: the confined absolute path the engine reads back and the
    // repo-relative path the fixer is told to write, from the ONE resolver (writer↔reader-location).
    resolveReportLocation: (repoDir, round) => {
      const abs = roundReportFile(repoDir, round);
      return abs ? { abs, rel: roundReportRel(round) } : null;
    },
    // §27.6 — the round-keyed consolidator-output location: the confined absolute path the engine reads back
    // and the repo-relative path the consolidator is told to write, from the ONE resolver (writer↔reader).
    resolveConsolidatorLocation: (repoDir, round) => {
      const abs = consolidatorOutputFile(repoDir, round);
      return abs ? { abs, rel: consolidatorOutputRel(round) } : null;
    },
    audit: (repoDir, cmd, exit) => audit.recordCommand(repoDir, 'turn', cmd, exit),
    emitError: (reason) => send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason }),
    onViewChanged: () => pushFlowChanged(),
    terminateFlow: (repoDir) => {
      flow.terminate(repoDir);
      pushFlowChanged();
    },
  });
  // Watch the §27 done-file (in the §27 loop area) for the active §27 turn, key-matched so a prior turn's
  // latched file cannot complete a different one — the §27 analogue of armTurnDoneWatch (§27.12).
  const armAppTurnDoneWatch = (repoDir: string): void => {
    unwatchAppTurnDone?.();
    unwatchAppTurnDone = watchTurnDone(
      repoDir,
      () => {
        if (readTurnDone(repoDir, appTurnDoneSubdir) === appEngine.activeTurnKey()) appEngine.onDoneSignal();
      },
      appTurnDoneSubdir,
    );
  };
  // The §8.3 active→quiet flip is the orchestrator's "instance is now injectable" signal (§26.2) —
  // assigned once the runners exist so the shadow's onStatus (built earlier) can fire it forward. Fans out
  // to both engines; the idle one no-ops (§27.15 — one instance, one turn in flight).
  notifyInjectable = () => {
    turnRunner.onInjectable();
    appEngine.onInjectable();
  };
  // Every §8.3 visible-content edge resets the in-flight turn's stall watchdog (§26.3): a streaming turn
  // keeps producing edges so it never stalls, while a frozen screen stops producing them and counts down.
  // Inert unless a turn is in flight (each runner guards it), so this is idle-cheap outside a loop.
  shadow.onActivity(() => {
    turnRunner.noteActivity();
    appEngine.noteActivity();
  });
  // §26.3/D47a — the turn-done file is the sole completion signal, so EVERY turn-starter must call this,
  // not just the work turn: a chain entered mid-run (§26.11 resume into reviewers/consolidate) would
  // otherwise have no completion trigger at all.
  const armTurnDoneWatch = (repoDir: string): void => {
    unwatchTurnDone?.();
    unwatchTurnDone = watchTurnDone(repoDir, () => {
      // §26.3/D46 — key-match: a prior turn's latched file must not complete a different in-flight turn.
      if (readTurnDone(repoDir) === activeTurn?.turnKey) turnRunner.onDoneSignal();
    });
  };
  const startWorkTurn = (repoDir: string, loopName: string, phase: string, preamble?: string): void => {
    activeTurn = { kind: 'work', repoDir, loopName, phase, turnKey: `work-${phase}` };
    armTurnDoneWatch(repoDir);
    turnPromptInjected = false; // §26 activity — a new turn starts in "waiting" until its prompt injects
    turnRunner.requestTurn(activeTurn.turnKey, { preamble });
  };
  // §26.3/D48 — clear an `error` status back to the turn's phase entry status (dropping the stale reason)
  // so the mirror leaves the error state. Shared by the Retry (re-drive) and the accept (advance) recovery
  // paths; a no-op when the def/phase can't be resolved (retry still proceeds to re-request the turn).
  const clearErrorToEntry = (repoKey: string, turn: ActiveTurn): void => {
    const def = parseLoopDef(repoKey, turn.loopName);
    const entryStatus = def?.phases.find((p) => p.id === turn.phase)?.entryStatus;
    if (!entryStatus) return;
    const s = parseAgentLoopState(repoKey);
    writeLoopState(repoKey, {
      status: entryStatus,
      iteration: s?.iteration ?? 1,
      pr: s?.pr ?? null,
      branch: s?.branch ?? null,
      boundLoop: turn.loopName,
      linkedIssues: s?.linkedIssues ?? [],
    });
    pushFlowChanged();
  };
  // §26.3/D48 recovery — re-drive the turn that stopped in `error` (e.g. after the operator starts Claude
  // for a `no hosted agent` stop). Clear the error status, then re-request the SAME turn: it injects if the
  // agent is now present, or stops in error again if not. No-op when no turn is active for this repo.
  const retryActiveTurn = (repoKey: string): void => {
    const turn = activeTurn; // capture: the intervening writes must not lose the null-narrowing
    if (!turn || turn.repoDir !== repoKey) return;
    clearErrorToEntry(repoKey, turn);
    turnRunner.requestTurn(turn.turnKey);
  };
  // §26.3/D47a(c) + D48 — the operator's "this turn is done" control. When the run stopped in `error` and
  // the errored turn's artifact is actually present (a late done-signal the engine gave up on — e.g. a plan
  // finished after the run erred), ACCEPT it: clear the error and chain to the next turn via the SAME path a
  // signalled completion takes (work→reviewers), WITHOUT re-running the turn — so an accepted plan is never
  // regenerated. Otherwise (a live in-flight turn) it is the D47a(c) manual-advance override, unchanged.
  const markTurnComplete = (repoKey: string): void => {
    const turn = activeTurn;
    if (turn && turn.repoDir === repoKey && parseAgentLoopState(repoKey)?.status === 'error') {
      if (!artifactPresentFor(turn)) return; // nothing to accept — Retry (re-run) is the path
      audit.recordCommand(turn.repoDir, 'turn', `turn ${turn.turnKey} accepted (artifact present)`, 0);
      clearErrorToEntry(repoKey, turn);
      chainAfter(turn);
      return;
    }
    turnRunner.markComplete();
  };
  // §26.5 — the plan-phase skip footprint, or null when there is no plan.md (the impl phase's file-set
  // footprint is a recorded v1 gap, so the skip-opt is confined to the plan phase where plan.md exists).
  const planFootprint = (repoDir: string): { kind: 'plan'; digest: string } | null => {
    const digest = planDigest(repoDir);
    return digest === '' ? null : { kind: 'plan', digest };
  };
  // §26.10 — price the run's accumulated session-log tokens (main session + subagent logs), swept from the
  // instant the flow started: the repo's project dir accumulates every session ever logged against it, so an
  // unbounded sweep reports the repo's lifetime spend rather than this run's. A flow with no recorded start
  // (one begun before the instant was persisted) sweeps unbounded rather than reporting nothing.
  // Best-effort: any failure degrades to $0 rather than aborting the loop's critical path (CLAUDE.md
  // side-effect rule).
  const iterationCost = (repoDir: string): CostResult => {
    try {
      const since = createFlowStateStore(repoDir).read()?.startedAt;
      return priceTokens(readSessionTokens(sessionLogDir(repoDir, process.env, os.homedir()), since));
    } catch {
      return { usd: 0, unpricedModels: [] };
    }
  };
  // §26.7 — CI runs, it does not block. At each iteration boundary take a BEST-EFFORT, NON-BLOCKING
  // snapshot of whatever CI state already exists on the non-draft PR and record it (display-only). This is
  // fire-and-forget: the loop has ALREADY advanced (gate STOP or re-iterate) by the time gh returns, so a
  // slow/pending CI check can never stall the loop (§26.7 removes the engine's polling ci-waiter).
  const captureCiSnapshot = (repoDir: string, pr: number | null, iteration: number): void => {
    if (pr === null) return; // no PR yet → no checks to read (§26.7 "omitted if none")
    void createRealCiChecks(repoDir)
      .snapshot(pr)
      .then((snap) => {
        if (snap) {
          audit.recordCi(repoDir, iteration, snap);
          pushFlowChanged();
        }
      });
  };
  // §26.4/§26.5 — fan the phase's reviewer roster out as parallel subagents, MINUS the personas the skip-opt
  // prunes: a persona clean last iteration with an unchanged plan footprint is dropped and its last-clean
  // review reused (carried forward), so the consolidator still reads a full set. An empty roster means
  // nothing to fan out; a fully-pruned roster carries every review forward and goes straight to consolidate.
  const startReviewersTurn = (repoDir: string, loopName: string, phase: string): void => {
    const def = parseLoopDef(repoDir, loopName);
    const roster = def ? reviewerRosterForPhase(def, phase) : [];
    if (roster.length === 0) return;
    const s = parseAgentLoopState(repoDir);
    const iteration = s?.iteration ?? 1;
    const fp = planFootprint(repoDir);
    const { active, pruned } = fp
      ? prunablePersonas(roster, readLoopExtension(repoDir).personaState, iteration, fp)
      : { active: roster, pruned: [] as string[] };
    if (pruned.length > 0) carryForwardReviews(repoDir, pruned, iteration - 1, iteration);
    if (active.length === 0) {
      // Every persona reused — no fan-out to run; /clear and consolidate the carried-forward reviews.
      startConsolidateTurn(repoDir, loopName, phase, iteration, CLEAR_PREAMBLE);
      return;
    }
    activeTurn = { kind: 'reviewers', repoDir, loopName, phase, turnKey: `review-${phase}`, personas: active, iteration };
    armTurnDoneWatch(repoDir);
    turnPromptInjected = false;
    turnRunner.requestTurn(activeTurn.turnKey);
  };
  // §26.3/D46 — the actor-boundary context reset, passed as the next turn's gated `preamble` so the turn
  // runner injects it only once the agent has re-quiesced (never on the racing done-signal file), then
  // waits for /clear to drain before the turn prompt. Replaces the old un-gated inject-then-mark-active.
  const CLEAR_PREAMBLE = '/clear';
  // §26.3/D45 — run the consolidate turn: a fresh main-instance turn that reads the fan-out's persona
  // reviews and writes `reviews/<iter>/consolidated.json` with a verdict (advances when that verdict
  // parses; retry-then-error on a missing/malformed one, like every turn).
  const startConsolidateTurn = (repoDir: string, loopName: string, phase: string, iteration: number, preamble?: string): void => {
    activeTurn = { kind: 'consolidate', repoDir, loopName, phase, turnKey: `consolidate-${phase}`, iteration };
    armTurnDoneWatch(repoDir);
    turnPromptInjected = false;
    turnRunner.requestTurn(activeTurn.turnKey, { preamble });
  };
  // §26.6/§26.13 L4 — branch on the consolidate verdict (normalized against the bound LoopDef taxonomy):
  // `clean` writes the phase's post-clean gate status and STOPs (awaits the human); `needs-work` writes
  // the next iteration at the phase entry status, /clear-s, and re-runs the work turn.
  const advanceAfterConsolidate = (finished: { repoDir: string; loopName: string; phase: string; iteration: number }): void => {
    const def = parseLoopDef(finished.repoDir, finished.loopName);
    const raw = consolidatedVerdict(finished.repoDir, finished.iteration);
    const verdict = def && raw !== null ? normalizeConsolidatedVerdict(def, raw) : 'needs-work';
    const phase = def?.phases.find((p) => p.id === finished.phase);
    const ext = readLoopExtension(finished.repoDir);
    // §26.8 — advance the stuck detector: the top-3-kept finding signature, compared against the prior
    // one. Two identical signatures in a row flags the run stuck, which routes the needs-work verdict to
    // the triage gate for the human to confirm impasse.
    const sig = findingSignature(consolidatedFindings(finished.repoDir, finished.iteration), def?.verdicts?.severityOrder ?? []);
    const impasse = nextImpasse(ext.impasse.lastFindingsSig, ext.impasse.consecutiveIdentical, sig);
    // §26.6/§26.8 — decide whether this needs-work verdict auto-iterates or STOPs at the phase's triage gate.
    const outcome = decideConsolidateOutcome({
      verdict,
      iteration: finished.iteration,
      postCleanGate: phase?.postCleanGate ?? '',
      postNeedsWorkGate: phase?.postNeedsWorkGate ?? '',
      capBaseline: ext.capBaseline,
      iterationCap: phase?.iterationCap ?? 0,
      stuck: impasse.stuck,
    });
    // §26.5 skip-opt — fold this iteration's clean personas (their own review verdict) into persona_state
    // with the current plan footprint, so the next fan-out can prune the unchanged-clean ones. Confined to
    // the plan phase (a plan footprint exists); the impl file-set footprint is a recorded v1 gap.
    const fp = planFootprint(finished.repoDir);
    const personaState = fp
      ? recordCleanPersonas(
          ext.personaState,
          (def ? reviewerRosterForPhase(def, finished.phase) : []).filter((p) => {
            const v = personaVerdict(finished.repoDir, finished.iteration, p);
            return v !== null && def !== null && isPersonaClean(def, v);
          }),
          finished.iteration,
          fp,
        )
      : null;
    // §26.10 — the display-only cost meter: price the run's accumulated session-log tokens at the iteration
    // boundary, persist it (strip readout), and record the per-iteration §25 cost event. Best-effort — a
    // failure here must never abort the loop (CLAUDE.md), so it degrades to $0 and the recorder never throws.
    const cost = iterationCost(finished.repoDir);
    const s = parseAgentLoopState(finished.repoDir);
    const base = {
      pr: s?.pr ?? null,
      branch: s?.branch ?? null,
      boundLoop: finished.loopName,
      linkedIssues: s?.linkedIssues ?? [],
      // §26.8 — persist the signature run on every consolidate so the next iteration can detect x2.
      impasse: { consecutiveIdentical: impasse.consecutiveIdentical, lastFindingsSig: impasse.lastFindingsSig },
      ...(personaState ? { personaState } : {}),
      cost,
    };
    if (outcome.kind === 'gate') {
      writeLoopState(finished.repoDir, { ...base, status: outcome.status, iteration: finished.iteration });
      audit.recordCost(finished.repoDir, finished.iteration, cost);
      captureCiSnapshot(finished.repoDir, s?.pr ?? null, finished.iteration);
      pushFlowChanged();
      return;
    }
    writeLoopState(finished.repoDir, {
      ...base,
      status: phase?.entryStatus ?? s?.status ?? '',
      iteration: outcome.nextIteration,
    });
    audit.recordCost(finished.repoDir, finished.iteration, cost);
    captureCiSnapshot(finished.repoDir, s?.pr ?? null, finished.iteration);
    pushFlowChanged();
    startWorkTurn(finished.repoDir, finished.loopName, finished.phase, CLEAR_PREAMBLE);
  };

  // §26.11 / L8 — auto-resume an interrupted run from <repo>/.agent-loop/state.yaml (decision in
  // loopResume.ts). Best-effort: any gap — no state, no bound loop, no resume_contract — is a silent no-op.
  const resumedRepos = new Set<string>();
  const resumeLoop = (repoDir: string): void => {
    const turnInFlight = turnRunner.state() === 'in-flight';
    const s = parseAgentLoopState(repoDir);
    if (!s) return;
    const loopName = readLoopExtension(repoDir).boundLoop;
    if (!loopName) return;
    const def = parseLoopDef(repoDir, loopName);
    if (!def?.resume) return;
    // §26.3/D48 recovery — a run persisted in `error` is NOT auto-re-driven (human-owned), but it IS
    // reconstructed (no injection) so the loop panel's Retry (re-run) and "mark turn complete" (accept the
    // present artifact and advance) act on the right turn after a relaunch. This is NOT one-shot: returning
    // to an error repo after a detour to another must re-point the single turn slot at THIS repo, or the
    // first repo's Retry silently no-ops (§16.3). Which turn errored is inferred from artifact evidence.
    // Single-phase defs only — the vendored plan-loop/impl-loop are single-phase; a multi-phase error's
    // phase is ambiguous from state.yaml alone (recorded gap).
    if (s.status === 'error') {
      if (!shouldReconstructErrorTurn(repoDir, activeTurn?.repoDir ?? null, turnInFlight)) return;
      if (def.phases.length !== 1) return;
      const errPhase = def.phases[0];
      const errRoster = reviewerRosterForPhase(def, errPhase.id);
      const kind = currentTurnByArtifacts(def.resume.midIterSafe, {
        reviewsStarted: errRoster.length > 0 && anyReviewPresent(repoDir, s.iteration, errRoster),
        reviewsComplete: errRoster.length > 0 && allReviewsPresent(repoDir, s.iteration, errRoster),
        consolidated: consolidatedVerdict(repoDir, s.iteration) !== null,
      });
      if (kind === 'post-consolidate') return; // the verdict branch, not a turn to reconstruct (recorded gap)
      audit.recordCommand(repoDir, 'resume', `reconstruct ${kind} error at iter ${s.iteration}`, 0);
      if (kind === 'work') {
        activeTurn = { kind: 'work', repoDir, loopName, phase: errPhase.id, turnKey: `work-${errPhase.id}` };
      } else if (kind === 'reviewers') {
        activeTurn = {
          kind: 'reviewers',
          repoDir,
          loopName,
          phase: errPhase.id,
          turnKey: `review-${errPhase.id}`,
          personas: errRoster,
          iteration: s.iteration,
        };
      } else {
        activeTurn = {
          kind: 'consolidate',
          repoDir,
          loopName,
          phase: errPhase.id,
          turnKey: `consolidate-${errPhase.id}`,
          iteration: s.iteration,
        };
      }
      // Arm the file watch for whichever turn was reconstructed, so the operator's Retry (which re-injects)
      // can complete via the turn-done file — the sole completion signal since §26 D42a.
      armTurnDoneWatch(repoDir);
      return;
    }
    // The DRIVING resume injects a turn, so it fires at most once per repo and never while a turn is in
    // flight (the single runner would drop the request) — unlike the reconstruct path above.
    if (!canResumeRepo(repoDir, resumedRepos, turnInFlight)) return;
    const phase = def.phases.find((p) => p.entryStatus === s.status);
    const roster = phase ? reviewerRosterForPhase(def, phase.id) : [];
    const decision = decideResume({
      status: s.status,
      iteration: s.iteration,
      phases: def.phases.map((p) => ({ id: p.id, entryStatus: p.entryStatus })),
      midIterSafe: def.resume.midIterSafe,
      artifacts: {
        reviewsStarted: roster.length > 0 && anyReviewPresent(repoDir, s.iteration, roster),
        reviewsComplete: roster.length > 0 && allReviewsPresent(repoDir, s.iteration, roster),
        consolidated: consolidatedVerdict(repoDir, s.iteration) !== null,
      },
    });
    if (decision.kind === 'none') return;
    resumedRepos.add(repoDir);
    audit.recordCommand(repoDir, 'resume', `resume ${decision.kind} at ${s.status} iter ${s.iteration}`, 0);
    if (decision.kind === 'work') startWorkTurn(repoDir, loopName, decision.phaseId);
    else if (decision.kind === 'reviewers') startReviewersTurn(repoDir, loopName, decision.phaseId);
    else if (decision.kind === 'consolidate') startConsolidateTurn(repoDir, loopName, decision.phaseId, decision.iteration);
    // Every turn of the iteration already produced its artifact — only the verdict branch remains.
    else advanceAfterConsolidate({ repoDir, loopName, phase: decision.phaseId, iteration: decision.iteration });
  };

  // `transitioningRepo` carries the active repoKey into the synchronous onEnterStep below, so a loop
  // step's in-app pickup (§26.9) knows which repo it is bootstrapping.
  let transitioningRepo: string | null = null;
  const inTransition = <T>(repoKey: string, fn: () => T): T => {
    transitioningRepo = repoKey;
    try {
      return fn();
    } finally {
      transitioningRepo = null;
    }
  };

  // §26.9 / L1 — entering a `bootstrap: pickup` loop step runs in-app pickup (gh/git + state.yaml write)
  // OUT OF BAND, replacing the retired §24.2.3 T3 injected `agent-loop pickup`. Fire-and-forget: on
  // completion it records an audit command event and pushes flow:onStateChanged so the T2 mirror
  // re-pulls and renders the freshly-written status. `audit` is built below but referenced lazily here.
  // The context one pickup run needs, captured so a wipe-and-retry conflict (§26.9) can re-fire the exact
  // same bootstrap after the operator confirms. `stepId` is the loop step to roll back to on failure/decline.
  interface PickupJob {
    repoKey: string;
    stepId: string;
    issue: number;
    loopName: string;
    def: LoopDef;
    pickup: PickupContract;
  }
  // Conflicts awaiting the operator's wipe/cancel answer, keyed by repo (one active flow per repo).
  const pendingConflict = new Map<string, PickupJob>();

  const firePickup = (job: PickupJob, wipeConflict: boolean): void => {
    const { repoKey, stepId, issue, loopName, def, pickup } = job;
    // §26 activity — the async bootstrap is now visibly in flight (the status bar shows "Bootstrapping #n"
    // + spinner). Cleared when the pickup resolves, whatever the outcome.
    pickupInFlight = { repoKey, issue, wipe: wipeConflict };
    pushFlowChanged();
    void runPickup(createRealPickupDeps(repoKey), { repoDir: repoKey, issue, loopName, pickup, wipeConflict })
      .then((result) => {
        if (pickupInFlight?.repoKey === repoKey) pickupInFlight = null;
        audit.recordCommand(repoKey, 'pickup', `pickup #${issue}`, result.ok ? 0 : 1);
        // The pickup is fire-and-forget: the operator may have terminated or navigated the flow off this
        // step while it ran. A stale result must not drive a turn, prompt a wipe, or roll back a step the
        // flow already left (§26.9) — otherwise a terminated flow gets a work prompt injected against it.
        const live = flow.state(repoKey);
        const action = decidePickupAction(result, live.status === 'in_progress' && live.stepName === stepId);
        switch (action.kind) {
          case 'stale':
            return;
          case 'work': {
            pushFlowChanged();
            // §26.3 / L2 — bootstrap done; drive the work-{phase} turn. The phase is the one whose
            // entry_status the freshly-written state.yaml now sits at (the bound def's first phase). §26 D42a
            // (Q3) — like every other loop-step entry, the first work turn is preceded by an actor-boundary
            // /clear (§26.3/D46) so the loop starts from a clean agent context.
            const phase = def.phases.find((p) => p.entryStatus === action.status)?.id ?? def.phases[0]?.id;
            if (phase) startWorkTurn(repoKey, loopName, phase, CLEAR_PREAMBLE);
            return;
          }
          case 'conflict':
            // §26.9 wipe-and-retry — the branch already exists and NOTHING destructive was done. Keep the
            // flow on the loop step and ask the operator to confirm the (destructive, outward-facing) wipe;
            // the answer returns on flow:resolveBootstrapConflict.
            pendingConflict.set(repoKey, job);
            send(CH.flowOnBootstrapConflict, { sessionId: SESSION_ID, branch: action.branch, repoKey });
            return;
          case 'revert':
            // §26.9 — hard failure (dirty tree / unresolvable base / …). NEVER leave the flow stranded on
            // the half-entered loop step: roll it back one step (Option C) and surface the reason in a
            // blocking error dialog (CLAUDE.md — a critical-path failure the operator cannot see or fix by
            // clicking must never be swallowed).
            flow.revertStep(repoKey, stepId);
            pushFlowChanged();
            send(CH.flowOnBootstrapError, { sessionId: SESSION_ID, reason: action.reason });
            return;
        }
      });
  };

  const runPickupForStep = (step: FlowStepDef, inputs: Record<string, string>): void => {
    const repoKey = transitioningRepo;
    if (!repoKey || step.kind !== 'loop' || !step.loop) return;
    const def = parseLoopDef(repoKey, step.loop);
    if (!def?.pickup) return; // no pickup_contract → nothing to bootstrap from
    const ticketInput = (step.inputs ?? []).find((i) => i.type === 'github-ticket');
    const raw = ticketInput ? inputs[ticketInput.name] : undefined;
    const issue = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    if (issue === null) return; // cannot bootstrap without a resolved github-ticket issue number
    firePickup({ repoKey, stepId: step.id, issue, loopName: step.loop, def, pickup: def.pickup }, false);
  };

  // §26.9 — the operator's answer to a bootstrap conflict. `wipe` re-fires the SAME job with the wipe
  // enabled; declining rolls the flow back one step (the flow was held on the loop step while the confirm
  // was up). A stale answer (nothing pending) is inert.
  const resolveBootstrapConflict = (repoKey: string, wipe: boolean): void => {
    const job = pendingConflict.get(repoKey);
    if (!job) return;
    pendingConflict.delete(repoKey);
    if (wipe) {
      firePickup(job, true);
      return;
    }
    flow.revertStep(repoKey, job.stepId);
    pushFlowChanged();
  };

  // §26 D42a — entering a loop step with NO `bootstrap: pickup` RESUMES the existing run under the step's
  // loop (`agent-loop resume --loop <new>`): rebind state.yaml to the new loop (fresh internal state, but
  // the same PR/branch/issues carried), then drive its first work turn behind an actor-boundary /clear
  // (§26.3/D46). Decision in loopRebind.ts; the "nothing to resume" outcomes are audited no-ops (a loop
  // step can be display-only), and only a persist failure mid-rebind is surfaced.
  const resumeLoopForStep = (step: FlowStepDef): void => {
    const repoKey = transitioningRepo;
    if (!repoKey || step.kind !== 'loop' || !step.loop) return;
    const prior = parseAgentLoopState(repoKey);
    const plan = planStepResume(
      prior && { pr: prior.pr, branch: prior.branch, linkedIssues: prior.linkedIssues, iteration: prior.iteration },
      step.loop,
      parseLoopDef(repoKey, step.loop),
    );
    if (!plan.ok) {
      // Nothing to resume (no def, no prior run, or a phase-less def). Not a blocking error: a loop step
      // can legitimately be display-only (its state.yaml mirror still renders), and the flow stays
      // recoverable via Terminate/Restart. Record why so the no-op leaves a trace (§25), never silent.
      audit.recordCommand(repoKey, 'resume', `loop step not resumed: ${plan.reason}`, 1);
      return;
    }
    try {
      writeLoopState(repoKey, plan.write);
    } catch (e) {
      // A persist failure DID interrupt a rebind that was going to run — surface it (the state on disk may
      // be half-written) so the operator can retry rather than sit on a silently-failed transition.
      send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason: `could not persist the loop rebind: ${String(e)}` });
      return;
    }
    startWorkTurn(repoKey, step.loop, plan.workPhase, CLEAR_PREAMBLE);
  };

  // §18.6/§19.3: a manual step's only automatic entry action is injecting its `skill`, refused over a
  // busy shell — a live OSC-133 command span means not at a ready prompt. A `bootstrap: pickup` loop
  // step runs in-app pickup instead (§26.9); a non-pickup loop step RESUMES the existing run (§26 D42a).
  // Must be built after the injector + tracker exist.
  const flowEntryActions = createFlowEntryActions({
    isShellBusy: () => tracker.summaries().some((s) => s.running),
    inject: (text) => inject(text, { submit: false }),
    runPickup: runPickupForStep,
    resumeLoop: resumeLoopForStep,
    // §27.15/§27.3 — an app-namespace step binds the §27 engine: start its work turn (run the declared
    // boundary, inject the work prompt once when injectable), NEVER a §26 run. The engine no-ops when the
    // def fails to resolve — the run-less/failure view (deriveAppLoopView) is the operator's surface then.
    enterAppLoop: (step) => {
      const repoKey = transitioningRepo;
      if (!repoKey || !step.loop) return;
      appEngine.enter(repoKey, step.loop, step.id);
      armAppTurnDoneWatch(repoKey);
    },
  });
  const flow = createFlowManager({
    globalDir: flowGlobalDir,
    onEnterStep: (step, inputs) => flowEntryActions(step, inputs),
    readLoopState: (repoKey) => parseAgentLoopState(repoKey),
    readLoopDef: (repoKey, name) => parseLoopDef(repoKey, name),
    // §26.10 — the display-only cost readout for the strip: format the last-recorded cost from the
    // orchestrator-owned extension (loopStateReader), or null before any iteration recorded one.
    readLoopCost: (repoKey) => {
      const c = readLoopExtension(repoKey).cost;
      return c ? formatCost(c) : null;
    },
    // §27.15 — the §27 (app-namespace) loop-view provider: resolve the bound app-def across the operator
    // and app-bundled tiers and produce its whole run-less/failure view. Tier roots are chosen by the
    // parsed namespace, never derived from repo content; the loop name is held to a safe segment inside
    // the resolver before any tier root is joined.
    readAppLoopView: (repoKey, name) =>
      provideAppLoopView(appEngine, name, {
        tiers: { operator: userConfigLoopsV2Dir(), appBundled: resolveExampleLoopsV2Dir(iconLoc) },
        repoDir: repoKey,
      }),
  });

  // §24.2.3 T7 — resolve a ticket/PR's title/body/url for the popout, best-effort via `gh`, cached.
  const githubRefs = createGithubRefs();

  // Flow audit record (§25): observe-only, best-effort — records each run's lifecycle to
  // ~/.agent-terminal/audit/<repo>/<flow>_<ts>.yaml. Never throws into the flow path.
  const audit = createAuditRecorder({
    root: auditRootDir(os.homedir()),
    now: () => new Date(),
    flowName: (repoKey) => {
      const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
      return load.ok ? load.definition.name : null;
    },
  });

  // T2 (§24.2.3): watch a loop repo's state.yaml so a hand-edit re-pushes over the EXISTING
  // flow:onStateChanged seam (§24.2.2 S5) — no new plumbing. One watcher per repo, established
  // lazily; since the strip just re-pulls, duplicate file events are harmless.
  const loopWatchers = new Map<string, () => void>();
  // T4 (§24.2.3): the raise/dedup decision lives in loopNotifier (unit-tested); only the untestable
  // Electron Notification surface is created here.
  const loopNotifier = createLoopNotifier({
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    onFocusChanged: (listener) => {
      win.on('blur', listener);
      win.on('focus', listener);
    },
    focusWindow: () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    reveal: () => send(CH.flowRevealLoop, { sessionId: SESSION_ID }),
    // A refused raise is indistinguishable from one never attempted unless it is recorded: macOS denies
    // an unsigned bundle outright (UNErrorDomain 1), which silently disabled this surface for its whole life.
    notify: ({ title, body, repoKey, onActivate }) => {
      if (!Notification.isSupported()) {
        audit.recordNotifyFailed(repoKey, 'the platform supports no notifications');
        return () => {};
      }
      const notification = new Notification({ title, body });
      notification.on('click', onActivate);
      notification.on('failed', (_event, error) => audit.recordNotifyFailed(repoKey, String(error)));
      notification.show();
      return () => notification.close();
    },
  });
  const trackLoop = (repoKey: string, view: FlowStateView): FlowStateView => {
    // Watch state.yaml whenever it feeds the view — the loop mirror (loop steps) OR the cross-step
    // refs (§24.2.3 T7, e.g. a PR appearing on a manual step) — so either updates live (§24.2.2 S5).
    // Only cache a watcher that actually attached: refs can show a typed-input ticket before the
    // .agent-loop dir exists, and caching a failed attempt would block re-attaching once it appears.
    if ((view.loop || view.refs) && !loopWatchers.has(repoKey)) {
      const unwatch = watchAgentLoopState(repoKey, pushFlowChanged);
      if (unwatch) loopWatchers.set(repoKey, unwatch);
    }
    loopNotifier.observe(repoKey, view);
    // §25.5: every view computation (including the state.yaml-watch re-pull) observes the loop mirror,
    // so an external `agent-loop` advance is recorded as well as one fired from the strip.
    audit.recordLoop(repoKey, view.loop ?? null);
    return view;
  };
  // todoTemplate:instantiate (§6/§4.1): add a named template's items to the repo's todo list; a
  // missing flow/template is a no-op returning the unchanged list.
  const instantiateTemplate = (repoKey: string, ref: string): ReturnType<typeof todoStore.list> => {
    const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
    if (!load.ok) return todoStore.list(repoKey);
    const md = loadTodoTemplateFile(todoTemplatesDir(load.flowDir), ref);
    if (md === null) return todoStore.list(repoKey);
    // Silent dedup (operator decision): re-firing a template skips items already outstanding, so a
    // repeat click never piles up duplicates.
    const active = new Set(todoStore.list(repoKey).filter((t) => t.status !== 'done').map((t) => t.text));
    let list = todoStore.list(repoKey);
    for (const text of parseTodoTemplate(md)) {
      if (active.has(text)) continue;
      list = todoStore.add(repoKey, text);
      active.add(text);
    }
    return list;
  };

  // §26 — the live "what the loop mechanics are doing now" descriptor, derived fresh on every view so a
  // spinner phrase is never stale. Scoped to the repo the view is for.
  const loopActivityFor = (repoKey: string): LoopActivity | null =>
    deriveLoopActivity({
      pickup: pickupInFlight?.repoKey === repoKey ? { issue: pickupInFlight.issue, wipe: pickupInFlight.wipe } : null,
      turn:
        activeTurn?.repoDir === repoKey && turnRunner.state() === 'in-flight'
          ? { kind: activeTurn.kind, injected: turnPromptInjected }
          : null,
    });

  const withDerived = (repoKey: string, view: FlowStateView): FlowStateView => {
    const base = deriveFlowView(view, todoStore.list(repoKey), agentActivity);
    const activity = loopActivityFor(repoKey);
    return activity ? { ...base, loopActivity: activity } : base;
  };

  // A flow transition that records its before/after audit diff (§25.5): capture the pre-state, run the
  // mutation inside the bootstrap-attribution window (inTransition), record, then re-derive. Shared by
  // the start/restart/undo handlers, which differ only by kind and mutation; advance/provideInput keep
  // their own bodies because their readiness/notice handling diverges.
  const recordedTransition = (repoKey: string, kind: TransitionKind, mutate: () => FlowStateView): FlowStateView => {
    const before = flow.state(repoKey);
    const after = inTransition(repoKey, mutate);
    audit.recordTransition(repoKey, kind, before, after);
    return trackLoop(repoKey, withDerived(repoKey, after));
  };

  // The audit before/after diff (§25.5) needs the PRE-mutation values, but todoStore mutates cached
  // items in place (setStatus/update) and list() hands back those references — a live list would
  // already read as the post-mutation state. Snapshot the values before mutating.
  const todoSnapshot = (repoKey: string): { id: string; text: string; status: TodoStatus }[] =>
    todoStore.list(repoKey).map((t) => ({ id: t.id, text: t.text, status: t.status }));

  // The current step's declared input types (§18.4), keyed by name — the audit classifier reads this
  // to tag a `github-ticket` value as a ticket association (§25.5). Empty when the definition or step
  // can't be resolved, so audit degrades to recording bare `input.resolved` events.
  const inputTypeMap = (repoKey: string): Record<string, string> => {
    const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
    if (!load.ok) return {};
    const step = load.definition.steps[flow.state(repoKey).position - 1];
    const map: Record<string, string> = {};
    for (const input of step?.inputs ?? []) map[input.name] = input.type;
    return map;
  };

  // The bound LoopDef name of the flow's current loop step for `repoKey` (§26.6 gate handler) — null when
  // the definition/step doesn't resolve or the current step is not a loop step.
  const boundLoopName = (repoKey: string): string | null => {
    const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
    if (!load.ok) return null;
    // §27.15 — the §26 gate-decision executor is a §26-only write surface; the selector refuses an
    // app-namespace step (the guard is at the operation), so a same-named operator §26 def is never fired
    // for a §27 step.
    return legacyLoopNameForStep(load.definition.steps[flow.state(repoKey).position - 1]);
  };

  // §26 D42a — advance the flow one step when a loop step's loop reaches a success terminal. Guarded on
  // in_progress (advance throws otherwise, e.g. a flow the operator terminated while the gate resolved) and
  // run inside inTransition so the next step's entry actions fire in transition context, matching the manual
  // advance handler. A no-op guard, never a throw: a raced non-in_progress flow is left untouched.
  const autoAdvanceFlow = (repoKey: string): void => {
    const pre = flow.state(repoKey);
    if (pre.status !== 'in_progress') return;
    const view = inTransition(repoKey, () => flow.advance(repoKey));
    audit.recordTransition(repoKey, 'advance', pre, view);
  };

  // §26.6 / L5 / D52 — execute the human's gate decision in-app (NOT an injected `/agent-loop-*` command,
  // retired §26.12): resolve the bound LoopDef + the gate at the current status, guard the option against
  // the gate's human_options, then run that option's action list (state write, gh side-effects out of
  // band, human note) and advance/re-iterate/stop. Best-effort: an unresolved gate or an unoffered option
  // is ignored (the loop stays where it is).
  const runGateDecision = (repoKey: string, option: GateOption, note: string): void => {
    const loopName = boundLoopName(repoKey);
    const s = parseAgentLoopState(repoKey);
    const def = loopName ? parseLoopDef(repoKey, loopName) : null;
    if (!loopName || !s || !def) return;
    const gate = gateForStatus(def, s.status);
    if (!gate || !gate.humanOptions.includes(option)) return; // not at a gate offering this option
    const outcome = decideGateOutcome(gate, option);
    const reiterPhase = def.phases.find((p) => p.entryStatus === outcome.nextStatus)?.id ?? def.phases[0]?.id;
    // Until the §19.4 feedback composer supplies the reason (a later slice), default an empty note to the
    // decision itself so the gate's `append-human-note` action always leaves an observable artifact.
    const noteText = note.trim().length > 0 ? note : `human ${option}`;
    // §26.6/D48 — a failed state write leaves the loop where it is (onWriteFailed); the flow must NOT
    // auto-advance over an unpersisted transition, so track the failure and gate the advance on it.
    let gateWriteFailed = false;
    void executeGateOutcome(
      outcome,
      {
        repoDir: repoKey,
        boundLoop: loopName,
        iteration: s.iteration,
        pr: s.pr,
        branch: s.branch,
        linkedIssues: s.linkedIssues,
        note: noteText,
        // §26.9 — skip epic-promote if this run already created its sub-issues (idempotent re-entry).
        epicAlreadyPromoted: readLoopExtension(repoKey).epic.subIssues.length > 0,
        // §26.6 — exec runs only for an operator-authored def (CWE-829), minus the repo's loops_deny_exec.
        execAllowed: loopExecAllowed(def, repoKey, loopName),
      },
      {
        github: createRealGateGitHub(repoKey),
        // §26.6 — resolve an exec action's `{{artifact.<id>}}` against the bound LoopDef; run it out of band.
        resolveArtifact: (id) => artifactPath(def, repoKey, id),
        runExec: createRealGateExec(repoKey),
        writeState: (state) => writeLoopState(repoKey, state),
        writeHumanNote: (iteration, text) => writeHumanNote(repoKey, iteration, text),
        // §26.9 / L8 — the epic classification the work-agent wrote into plan.md gates epic-promote.
        readEpicPlan: () => readEpicPlan(repoKey),
        // §26.6 — request-changes re-runs the phase's work turn in a fresh context (the next iteration is
        // already persisted by executeGateOutcome, so the work prompt reads the incremented count).
        reiterate: () => {
          if (reiterPhase) {
            startWorkTurn(repoKey, loopName, reiterPhase, CLEAR_PREAMBLE);
          }
        },
        // §26.6/D48 — a gate transition that could not be persisted is never silent: surface the reason in
        // the blocking error dialog and record it, so the loop can never sit stranded with no trace.
        onWriteFailed: (reason) => {
          gateWriteFailed = true;
          audit.recordCommand(repoKey, 'gate', `gate ${option} write failed: ${reason}`, 1);
          send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason: `could not persist gate transition: ${reason}` });
        },
      },
    ).then(() => {
      audit.recordCommand(repoKey, 'gate', `gate ${option}`, 0);
      // §26 D42a — a SUCCESS terminal (approve terminating the loop) means this flow's loop step is done,
      // so auto-advance the flow to its next step. Impasse/error terminals are human-owned and never
      // advance; a failed state write leaves the loop unmoved, so never advance over it.
      if (!gateWriteFailed && shouldAdvanceFlowOnGate(option, outcome)) autoAdvanceFlow(repoKey);
      pushFlowChanged();
    });
  };

  // §27.9/§27.13 / N5 — composition root for the §27 gate decision; isolated from the §26 executor above (AC8).
  // Returns the request-changes delivered/dropped result so the two-way flow:appRequestChanges caller can hold
  // the composer open on a drop (approve goes through the one-way channel and ignores the result).
  const runAppGateDecision = (repoKey: string, step: string, turnKey: string, option: GateDecisionOption, note?: string): Promise<boolean> =>
    runAppGateDecisionImpl(
      repoKey,
      step,
      turnKey,
      option,
      {
        readRunState: (repoDir) => readAppLoopState(repoDir),
        resolveDef: (repoDir, name) => resolveLoopDefV2(name, appDefContext(repoDir)),
        refs: (repoDir) => {
          const v = flow.state(repoDir);
          return { pr: v.refs?.pr ?? null, ticket: v.refs?.ticket ?? null };
        },
        bodyFile: (def) => completionArtifact(def)?.path ?? null,
        runSideEffect: createRealAppGateGitHub(repoKey),
        persistAccept: (repoDir, state) => writeAppLoopState(repoDir, state),
        advanceFlow: (repoDir) => autoAdvanceFlow(repoDir),
        audit: (repoDir, cmd, exit) => audit.recordCommand(repoDir, 'gate', cmd, exit),
        emitError: (reason) => send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason }),
        onViewChanged: () => pushFlowChanged(),
        // §27.9/AC4 — the resume+done-watch preamble mirrors the flowAppRouteOut handler below; both drive a
        // §27 engine that is idle for this repoDir after a relaunch (there is no launch-time §27 resume).
        // TODO(dylanb): the resume-if-not-active leg is deferred coverage, not an untestability exemption — a
        // cold-relaunch-then-request-changes @ownapp test (mirroring the §26 cd-resume e2e) closes it.
        deliverFeedback: (repoDir, s, tk, feedback) => {
          if (appEngine.activeRepoDir() !== repoDir) appEngine.resume(repoDir);
          armAppTurnDoneWatch(repoDir);
          return appEngine.requestChanges(repoDir, s, tk, feedback);
        },
        // §27.9/AC5 — redo re-enters the work turn; same resume+done-watch preamble as deliverFeedback so a
        // §27 engine idle for this repoDir after a relaunch reconstructs the gate before the clean-slate re-entry.
        deliverRedo: (repoDir, s, tk, instruction) => {
          if (appEngine.activeRepoDir() !== repoDir) appEngine.resume(repoDir);
          armAppTurnDoneWatch(repoDir);
          return appEngine.redo(repoDir, s, tk, instruction);
        },
        // §27.9/AC6 — polish is app-owned loop state written to its own file (never the §26 surface).
        enterPolish: (repoDir, step) => enterPolish(repoDir, step),
        clearPolish: (repoDir) => clearPolish(repoDir),
      },
      note,
    );

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee. Turn completion is detected
  // via the .agent-loop/turn-done FILE only (§26.3/D47a; §26 D42a retired the echo-hazardous line scanner).
  ptyProcess.onData((data) => {
    outputGate.send(data);
    shadow.write(data);
  });
  // The hosted shell IS the session (§5); a sub-grace exit is excepted (shellExit.ts).
  ptyProcess.onExit(({ exitCode }) => {
    ptyIo.markExited(); // a kept-open window (§5) must not drive the dead shell — see ptyIo.ts
    send(CH.ptyExit, { sessionId: SESSION_ID, code: exitCode });
    if (shouldTerminateOnShellExit(performance.now() - shellSpawnedAt, config.startupExitGraceMs) && !win.isDestroyed()) {
      win.close();
    }
  });

  const disposeIpc = registerIpcListeners(
    ipcMain,
    {
      [CH.ptyInput]: (_e, m) => {
        if (isValidInput(m)) ptyIo.io.write(m.data);
      },
      // PTY and shadow must never diverge in size, or captures mis-wrap (§4 flow F).
      [CH.ptyResize]: (_e, m) => {
        if (isValidResize(m)) {
          ptyIo.io.resize(m.cols, m.rows);
          shadow.resize(m.cols, m.rows);
        }
      },
      [CH.monitorCapture]: (_e, m) => {
        if (isValidCapture(m)) send(CH.monitorEvent, { sessionId: SESSION_ID, event: store.addCapture(m) });
      },
      // Dismiss removes from the store so a reloaded pane's replay won't resurrect it;
      // removing a report cascades to its findings (§15.6 / v2.6).
      [CH.monitorDismiss]: (_e, m) => {
        if (isValidDismiss(m)) store.remove(m.eventId);
      },
      [CH.monitorDismissAll]: (_e, m) => {
        if (isValidDismissAll(m)) store.clear();
      },
      // Mark as chrome (§15.x): learn the block's glyphs so future furniture is filtered, then retract
      // this capture (cascading to findings) so a reloaded pane's replay won't resurrect it.
      [CH.monitorLearnChrome]: (_e, m) => {
        if (!isValidLearnChrome(m)) return;
        chromeProfile.learn(learnMarkers(m.sample));
        store.remove(m.eventId);
        send(CH.monitorEventRemoved, { sessionId: SESSION_ID, eventId: m.eventId });
      },
      [CH.agentInject]: (_e, m) => {
        if (isValidInject(m)) inject(m.text, { submit: m.submit });
      },
      // §26.3/D47a(c) + D48 — the operator's "this turn is done" control: a manual advance for a live
      // in-flight turn, or (on an `error` with the artifact present) accept-and-advance without re-running.
      [CH.flowMarkTurnComplete]: (_e, m) => {
        if (isValidFlowRequest(m)) markTurnComplete(m.repoKey);
      },
      // §26.6 / L5 — the human's data-driven gate decision, executed app-internally.
      [CH.flowGateDecision]: (_e, m) => {
        if (isValidFlowGateDecision(m)) runGateDecision(m.repoKey, m.option, m.note ?? '');
      },
      // §26.3/D48 — recover a loop stopped in `error`: re-drive the failed turn (e.g. after the operator
      // starts Claude for a `no hosted agent` stop).
      [CH.flowRetryTurn]: (_e, m) => {
        if (isValidFlowRequest(m)) retryActiveTurn(m.repoKey);
      },
      // §27.12c — the §27-only work-turn route-out (retry / accept-present-artifact / terminate), acting on
      // the step+turn identity the payload names (§6), never ambient state. After a relaunch the engine has
      // no live turn, so reconstruct the stopped turn from the persisted §27 run state first (never re-driven
      // — only made routable); a live turn for this repo already matches, so the resume is skipped. The
      // done-file watch is armed unconditionally: the derived view (provideAppLoopView) may have already
      // reconstructed the stranded turn, so gating the arm on the resume would leave a Retry re-injection
      // without a completion signal — injector and completion signal must be armed together (§27.12).
      [CH.flowAppRouteOut]: (_e, m) => {
        if (!isValidFlowAppRouteOut(m)) return;
        if (appEngine.activeRepoDir() !== m.repoKey) appEngine.resume(m.repoKey);
        armAppTurnDoneWatch(m.repoKey);
        appEngine.routeOut(m.repoKey, m.step, m.turnKey, m.action);
      },
      // §27.9/§27.13 / N5 / §6 / AC7 — approve (and other one-way options); the result is not observed here.
      [CH.flowAppGateDecision]: (_e, m) => {
        if (!isValidFlowAppGateDecision(m)) return;
        void runAppGateDecision(m.repoKey, m.step, m.turnKey, m.option);
      },
      // §27.9/AC9 — arm the §27 queued interrupt for the step the payload names (§6). Persisted independently
      // of the run-state document (armInterrupt), so it survives a relaunch and no turn-status write clobbers
      // it; the consolidator honors it at its next invocation. Best-effort: a write failure (planted symlink,
      // ENOSPC) must never crash the IPC handler — the arm simply does not land, and the operator can retry.
      [CH.flowArmInterrupt]: (_e, m) => {
        if (!isValidFlowArmInterrupt(m)) return;
        try {
          armInterrupt(m.repoKey, m.step);
        } catch (e) {
          send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason: `could not arm the interrupt: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        pushFlowChanged();
      },
      // §26.9 — the operator's wipe/cancel answer to a bootstrap conflict.
      [CH.flowResolveBootstrapConflict]: (_e, m) => {
        if (isValidFlowResolveBootstrapConflict(m)) resolveBootstrapConflict(m.repoKey, m.wipe);
      },
      // Clipboard is an OS resource owned by main (§7.7); the sandboxed preload can't reach it.
      [CH.clipboardWrite]: (_e, m) => {
        if (isValidClipboardWrite(m)) clipboard.writeText(m.text);
      },
      // Global UI prefs (§16.6) — no sessionId; persisted to userData.
      [CH.uiSetSettings]: (_e, m) => {
        if (isValidSetSettings(m)) uiSettings.set(m.settings);
      },
    },
    {
      [CH.monitorReplay]: () => store.list(),
      // §16.3: this query exists because cwd:changed fires only on key change, so a pane that mounted
      // after the first OSC 7 learns the repo key only by asking. Falls back to the spawn cwd (else
      // todos no-op for lack of a key), mirroring viewerCwd (§20.1).
      [CH.monitorCurrentRepo]: () =>
        currentRepoInfo(cwdTracker.cwd(), cwdTracker.repoKey(), launchRoot),
      [CH.uiGetSettings]: () => uiSettings.get(),
      [CH.clipboardRead]: (): string => clipboard.readText(), // Paste source (§7.7)
      // "Capture last report" (§21.1): returned to the caller, never broadcast — onEvent would prepend
      // a duplicate rather than replace the single slot. Fail-closed to [], which the renderer reads as
      // "nothing captured, keep the prior report" (§6 live-session check).
      [CH.captureLast]: (_e, m) =>
        isValidCaptureLast(m) ? captureLastReport(SESSION_ID, store, scanner) : [],
      // §27.9/AC4 — request-changes is TWO-way (unlike approve): it returns whether the round started so the
      // feedback composer holds open on a drop and never loses the human's input. Fail-closed to false.
      [CH.flowAppRequestChanges]: (_e, m) =>
        isValidFlowAppRequestChanges(m) ? runAppGateDecision(m.repoKey, m.step, m.turnKey, 'request-changes', m.feedback) : false,
      // §27.9/AC5 — redo is TWO-way like request-changes: it returns whether the work turn re-entered so the redo
      // composer holds open on a drop and never loses the human's instruction. The instruction rides as `note`.
      // Fail-closed to false.
      [CH.flowAppRedo]: (_e, m) =>
        isValidFlowAppRedo(m) ? runAppGateDecision(m.repoKey, m.step, m.turnKey, 'redo', m.instruction) : false,
      // Todo CRUD (§16.4): fail-closed to [] on a malformed payload, so a bad message can never mutate
      // another repo's list. A mutation that moves the n/m count (add/setStatus/delete) pushes
      // flow:onStateChanged so the strip's derived count follows (§24.2.2 S5).
      [CH.todoList]: (_e, m) => (isValidTodoList(m) ? todoStore.list(m.repoKey) : []),
      [CH.todoAdd]: (_e, m) => {
        if (!isValidTodoAdd(m)) return [];
        const before = todoSnapshot(m.repoKey);
        const list = todoStore.add(m.repoKey, m.text, m.source);
        audit.recordTodoChange(m.repoKey, before, list);
        pushFlowChanged();
        return list;
      },
      [CH.todoUpdate]: (_e, m) => {
        if (!isValidTodoUpdate(m)) return [];
        const before = todoSnapshot(m.repoKey);
        const list = todoStore.update(m.repoKey, m.id, m.text);
        audit.recordTodoChange(m.repoKey, before, list);
        return list;
      },
      [CH.todoReorder]: (_e, m) => (isValidTodoReorder(m) ? todoStore.reorder(m.repoKey, m.orderedIds) : []),
      [CH.todoSetStatus]: (_e, m) => {
        if (!isValidTodoSetStatus(m)) return [];
        const before = todoSnapshot(m.repoKey);
        const list = todoStore.setStatus(m.repoKey, m.id, m.status);
        audit.recordTodoChange(m.repoKey, before, list);
        pushFlowChanged();
        return list;
      },
      [CH.todoDelete]: (_e, m) => {
        if (!isValidTodoDelete(m)) return [];
        const before = todoSnapshot(m.repoKey);
        const list = todoStore.delete(m.repoKey, m.id);
        audit.recordTodoChange(m.repoKey, before, list);
        pushFlowChanged();
        return list;
      },
      // Artifact viewer (§20.1/§20.2): discover/read against the live cwd (see viewerCwd). Read is
      // path-escape-guarded.
      [CH.viewerTree]: (_e, m) => (isValidViewerTree(m) ? discover(viewerCwd(), m.scope) : emptyTree(viewerCwd())),
      [CH.viewerRead]: (_e, m) => (isValidViewerRead(m) ? readArtifact(viewerCwd(), m.relPath) : null),
      // Flow lifecycle (§24.2.2). An illegal transition throws (machine invariant) → the invoke
      // rejects and the strip re-pulls; a malformed payload fails closed to a benign error view.
      [CH.flowState]: (_e, m) =>
        isValidFlowRequest(m) ? trackLoop(m.repoKey, withDerived(m.repoKey, flow.state(m.repoKey))) : flowRequestError(),
      [CH.flowStart]: (_e, m) =>
        isValidFlowRequest(m) ? recordedTransition(m.repoKey, 'start', () => flow.start(m.repoKey)) : flowRequestError(),
      // Advancing while NOT ready is a human override (§19.2): warns via a one-shot notice but still
      // completes. Readiness is read from the PRE-advance state — loop readiness for a loop step, else
      // the todo gate (S5).
      [CH.flowAdvance]: (_e, m) => {
        if (!isValidFlowRequest(m)) return flowRequestError();
        const pre = withDerived(m.repoKey, flow.state(m.repoKey));
        const ready = pre.loop ? pre.loop.ready : (pre.derived?.ready ?? true);
        const view = inTransition(m.repoKey, () => flow.advance(m.repoKey));
        audit.recordTransition(m.repoKey, 'advance', pre, view);
        if (ready) return trackLoop(m.repoKey, view);
        const notice = pre.loop
          ? 'Advanced while the loop still needs you.'
          : 'Advanced with todos still outstanding.';
        return trackLoop(m.repoKey, { ...view, notice });
      },
      [CH.flowRestart]: (_e, m) =>
        isValidFlowRequest(m) ? recordedTransition(m.repoKey, 'restart', () => flow.restart(m.repoKey)) : flowRequestError(),
      [CH.flowUndo]: (_e, m) =>
        isValidFlowRequest(m) ? recordedTransition(m.repoKey, 'undo', () => flow.undo(m.repoKey)) : flowRequestError(),
      // Terminate (#26): inert from not_started / load-error (the control is absent there, AC2) — guard
      // on the pre-state so a malformed/raced request never clears on an error flow. The audit write is
      // best-effort (§25.7) and never blocks the reset (AC5–AC7 hold unconditionally). Per AC9/AC10
      // nothing here signals the terminal process or touches external agent-loop engine state.
      [CH.flowTerminate]: (_e, m) => {
        if (!isValidFlowRequest(m)) return flowRequestError();
        const before = flow.state(m.repoKey);
        if (before.status !== 'in_progress' && before.status !== 'done') {
          return trackLoop(m.repoKey, withDerived(m.repoKey, before));
        }
        const after = flow.terminate(m.repoKey);
        audit.recordTerminate(m.repoKey);
        todoStore.clear(m.repoKey);
        store.clear();
        send(CH.monitorCleared, { sessionId: SESSION_ID });
        pushFlowChanged();
        return trackLoop(m.repoKey, withDerived(m.repoKey, after));
      },
      // Provide a step's typed input (§18.4 / §24.2.3 T3); the returned view's notice carries any §19.3
      // busy-shell refusal.
      [CH.flowProvideInput]: (_e, m) => {
        if (!isValidFlowProvideInput(m)) return flowRequestError();
        audit.recordInputs(m.repoKey, m.values, inputTypeMap(m.repoKey));
        const view = inTransition(m.repoKey, () => flow.provideInput(m.repoKey, m.values));
        return trackLoop(m.repoKey, withDerived(m.repoKey, view));
      },
      [CH.flowSetTitle]: (_e, m) => {
        if (!isValidFlowSetTitle(m)) throw new Error('invalid flow:setTitle request');
        if (!knownRepoKeys.has(m.repoKey)) throw new Error('cannot name an unregistered repo');
        const view = flow.setTitle(m.repoKey, m.title);
        pushFlowChanged();
        return trackLoop(m.repoKey, withDerived(m.repoKey, view));
      },
      // §24.2.3 T7 — resolve a ref's detail for the popout (best-effort; null degrades to bare number).
      [CH.flowGithubRef]: (_e, m): Promise<GithubRef | null> =>
        isValidFlowGithubRef(m) ? githubRefs(m.repoKey, m.kind, m.number) : Promise.resolve(null),
      // §24.2.3 T7 — open a ref's GitHub url externally. The OS receives the NORMALIZED url the
      // allow-list approved (CWE-601), never the raw payload, so a host-spoofing control char can't
      // make a permissive OS handler open a different host than was validated.
      [CH.appOpenExternal]: async (_e, m): Promise<boolean> => {
        const url = openExternalTarget(m);
        if (url === null) return false;
        await shell.openExternal(url);
        return true;
      },
      // Template picker (§6/§4.1): GATED to an in_progress step (operator decision — the picker shows
      // only while a step is active) and carries the step's bound template as the default.
      [CH.todoTemplateList]: (_e, m) => {
        if (!isValidTemplateList(m)) return { templates: [] };
        if (flow.state(m.repoKey).status !== 'in_progress') return { templates: [] };
        const load = loadFlowDefinitionLocalFirst(m.repoKey, flowGlobalDir);
        const templates = load.ok ? listTodoTemplates(todoTemplatesDir(load.flowDir)) : [];
        const defaultRef = flow.state(m.repoKey).templateRef;
        return defaultRef ? { templates, defaultRef } : { templates };
      },
      [CH.todoTemplateInstantiate]: (_e, m) => {
        if (!isValidTemplateInstantiate(m)) return [];
        const before = todoSnapshot(m.repoKey);
        const list = instantiateTemplate(m.repoKey, m.ref);
        audit.recordTodoChange(m.repoKey, before, list); // §25.5
        pushFlowChanged(); // instantiation can add todos → the strip's n/m total moves (§24.2.2 S5)
        return list;
      },
      [CH.cliInstall]: (_e, m): CliInstallResult =>
        handleCliInstall(m, () => ({
          home: os.homedir(),
          shell: resolveShellPath(process.env, os.userInfo().shell ?? undefined),
          currentPath: process.env.PATH ?? '',
          invocation: resolveLaunchInvocation(
            process.execPath,
            process.defaultApp === true,
            process.argv[1],
            process.cwd(),
          ),
        })),
      // Install bundled examples (§18.1/§23.4/§26.5): bundles resolve build-aware (packaged resources vs
      // the unpackaged app path); the flow lands in the GLOBAL flow home read back by
      // loadFlowDefinitionLocalFirst, and the definitions, persona skills and commands land in the
      // user-level Claude config directories that the engine and Claude Code discover from.
      [CH.installExamplesPreview]: (_e, m) => handleInstallExamplesPreview(m, exampleDirs),
      [CH.installExamplesApply]: (_e, m) => handleInstallExamplesApply(m, exampleDirs),
    },
  );

  win.on('closed', () => {
    // §5 grace-kept-open close: the shell may already have exited, so ptyProcess.kill() can throw
    // ESRCH — each step is isolated so one failure never strands the others (disposeAll).
    disposeAll([
      () => disposeIpc(),
      () => ptyProcess.kill(),
      () => scanner.dispose(),
      () => suppressor.dispose(),
      () => cwdTracker.dispose(),
      () => tracker.dispose(),
      () => shadow.dispose(),
      () => stopViewerWatch(),
      () => {
        for (const stop of loopWatchers.values()) stop();
        loopWatchers.clear();
      },
      () => {
        if (turnTimer) clearTimeout(turnTimer);
      },
      () => {
        if (appTurnTimer) clearTimeout(appTurnTimer);
      },
      () => unwatchTurnDone?.(),
      () => unwatchAppTurnDone?.(),
    ]);
  });

  const target = resolveRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  if (target.kind === 'url') await win.loadURL(target.url);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));

  outputGate.open();

  // §26.11 / L8 — on launch, auto-resume an interrupted run in the launch-root repo (the §23.4 spawn cwd).
  // Absent/complete/human-owned state is a no-op. The deferred turn injects once the hosted instance is
  // injectable (§26.2). (The best-effort mid-session `cd`-into-repo resume trigger is a recorded v1 gap:
  // once the hosted instance occupies the shell the cwd rarely changes, and injecting a resumed turn into a
  // bare bash prompt before an agent is launched is the §26.11/B11 no-interlock risk — deferred.)
  resumeLoop(launchRoot);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
