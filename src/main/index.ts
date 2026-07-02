import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, shell } from 'electron';
import { buildMenuTemplate } from './appMenu';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  CH,
  SESSION_ID,
  type AgentState,
  type ChannelPayloads,
  type CommandCaptureResult,
  type CommandSummary,
  type FlowStateView,
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
  isValidCaptureCommand,
  isValidCaptureLast,
  isValidClearCommands,
  isValidCommandsRequest,
  isValidDismiss,
  isValidDismissAll,
  isValidFlowRequest,
  isValidFlowProvideInput,
  isValidFlowGateDecision,
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
import { currentRepoInfo } from './repoKey';
import { createScanner } from './scanner';
import { captureLastReport } from './captureLast';
import { createFlowManager, deriveFlowView, loadFlowDefinitionLocalFirst } from './flow';
import { createGithubRefs } from './githubRefs';
import { createAuditRecorder } from './auditRecorder';
import type { TransitionKind } from '../shared/audit';
import { auditRootDir } from './auditPaths';
import { createFlowEntryActions } from './flowEntryActions';
import { parseAgentLoopState, watchAgentLoopState } from './agentLoopBridge';
import { createLoopNotifier } from './loopNotifier';
import { parseLoopDef, gateForStatus, reviewerRosterForPhase, normalizeConsolidatedVerdict, isPersonaClean } from './loopDef';
import { runPickup, createRealPickupDeps } from './loopPickup';
import { createTurnRunner, decideConsolidateOutcome, type TurnRunner } from './loopOrchestrator';
import { composeWorkPrompt, composeSpawnReviewersPrompt, composeConsolidatePrompt } from './loopRecipe';
import { allReviewsPresent, consolidatedVerdict, consolidatedFindings, personaVerdict, carryForwardReviews, planDigest } from './reviewArtifacts';
import { findingSignature, nextImpasse } from './findingSignature';
import { readSessionTokens, sessionLogDir } from './costMeter';
import { createRealCiChecks } from './ciChecks';
import { priceTokens, formatCost, type CostResult } from '../shared/pricing';
import { prunablePersonas, recordCleanPersonas } from './personaSkip';
import { decideGateOutcome } from './gateActions';
import { executeGateOutcome } from './gateExecutor';
import { createRealGateGitHub } from './gateGithub';
import { writeHumanNote } from './humanNotes';
import { readEpicPlan } from './epicPlan';
import { createSentinelWatcher } from './turnSentinel';
import { readAndClearTurnDone, watchTurnDone } from './turnDoneFile';
import { writeLoopState } from './loopStateWriter';
import { readLoopExtension } from './loopStateReader';
import { decideResume } from './loopResume';
import { turnDoneSentinel } from '../shared/loopTurn';
import { statSync } from 'node:fs';
import type { FlowStepDef } from './flow';
import { listTodoTemplates, loadTodoTemplateFile, parseTodoTemplate } from './todoTemplate';
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
import type { CliInstallResult } from '../shared/ipc';

async function createWindow(): Promise<void> {
  const iconLoc = {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
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
  // hidden native selection. Off darwin buildMenuTemplate returns null and we leave the default menu.
  // TODO(keymap): the menu-accelerator→IPC dispatch is macOS-only, so it has no Linux e2e; the pure
  // template (appMenu.test) and the renderer router (menuActions.test) are unit/DOM covered.
  const menuTemplate = buildMenuTemplate(process.platform, (action) => send(CH.menuEdit, { action }));
  if (menuTemplate) Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

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
  // Command history is live off the OSC-133 marks, not §8.3 quiescence (§15.5).
  tracker.onChange(() => send(CH.monitorCommandsChanged, { sessionId: SESSION_ID }));
  // §16.3: broadcast only on repo-key change, so the pane swaps its todo list once per `cd` across a
  // repo boundary rather than on every cwd move.
  // TODO(dylan): the full OSC-7 → cwd:changed → repo-list-swap loop through real
  // node-pty + bash is verified in the §F e2e (plan PR5 5c) — recorded gap.
  const cwdTracker = createCwdTracker({ onOsc: (id, cb) => shadow.onOsc(id, cb) });
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
    send(CH.cwdChanged, { sessionId: SESSION_ID, cwd, repoKey });
    stopViewerWatch();
    stopViewerWatch = watchViewerTree(viewerRoot(cwd), onViewerActivity);
    void warmBase();
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
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let unwatchTurnDone: (() => void) | null = null;
  let turnRunner: TurnRunner;
  const turnSentinel = createSentinelWatcher(() => turnRunner.onDoneSignal());
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
        tokens: {
          ITERATION: String(s?.iteration ?? 1),
          PR_NUMBER: s?.pr != null ? String(s.pr) : '',
          HEAD_REF: s?.branch ?? '',
          PLAN_LINE_THRESHOLD: '1000',
        },
      });
    },
    inject: (prompt) => {
      if (activeTurn) turnSentinel.arm(turnDoneSentinel(activeTurn.turnKey));
      inject(prompt, { submit: true });
    },
    injectable: () => agentActivity === 'quiet',
    artifactPresent: () => {
      if (!activeTurn) return false;
      if (activeTurn.kind === 'reviewers') {
        return allReviewsPresent(activeTurn.repoDir, activeTurn.iteration, activeTurn.personas);
      }
      if (activeTurn.kind === 'consolidate') {
        return consolidatedVerdict(activeTurn.repoDir, activeTurn.iteration) !== null;
      }
      try {
        return statSync(path.join(activeTurn.repoDir, '.agent-loop', 'plan.md')).size > 0;
      } catch {
        return false;
      }
    },
    armTimer: () => {
      if (turnTimer) clearTimeout(turnTimer); // self-clearing: a re-arm (defer→inject) replaces, never leaks
      turnTimer = setTimeout(() => turnRunner.onTimeout(), config.turnCompletionTimeoutMs);
    },
    cancelTimer: () => {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
      turnSentinel.disarm();
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
      });
      audit.recordCommand(activeTurn.repoDir, 'turn', `turn ${activeTurn.turnKey} failed: ${reason}`, 1);
      pushFlowChanged();
    },
    onComplete: (turnKey) => {
      const finished = activeTurn;
      if (finished) audit.recordCommand(finished.repoDir, 'turn', `turn ${turnKey} complete`, 0);
      pushFlowChanged();
      // §26.4 — the work turn's completion chains into the reviewer fan-out (same loop, same iteration).
      if (finished?.kind === 'work') startReviewersTurn(finished.repoDir, finished.loopName, finished.phase);
      // §26.3/D46 — the fan-out chains into the consolidate turn, /clear-ing the instance first so the
      // consolidator merges in a fresh main-instance context (the work-agent's context cannot bias it).
      else if (finished?.kind === 'reviewers') {
        clearContext();
        startConsolidateTurn(finished.repoDir, finished.loopName, finished.phase, finished.iteration);
      }
      // §26.6 — the consolidate verdict decides the branch (clean STOPs at the gate, needs-work re-iterates).
      else if (finished?.kind === 'consolidate') advanceAfterConsolidate(finished);
    },
  });
  // The §8.3 active→quiet flip is the orchestrator's "instance is now injectable" signal (§26.2) —
  // assigned once the runner exists so the shadow's onStatus (built earlier) can fire it forward.
  notifyInjectable = () => turnRunner.onInjectable();
  // Bind a freshly-bootstrapped loop step's work turn: watch for its done-signal file and request the
  // turn (injected when the instance next goes injectable). The watcher stays attached across the turns
  // chained off this one (work → reviewers), so each turn's done-signal file is seen.
  const startWorkTurn = (repoDir: string, loopName: string, phase: string): void => {
    activeTurn = { kind: 'work', repoDir, loopName, phase, turnKey: `work-${phase}` };
    unwatchTurnDone?.();
    unwatchTurnDone = watchTurnDone(repoDir, () => {
      if (readAndClearTurnDone(repoDir) !== null) turnRunner.onDoneSignal();
    });
    turnRunner.requestTurn(activeTurn.turnKey);
  };
  // §26.5 — the plan-phase skip footprint, or null when there is no plan.md (the impl phase's file-set
  // footprint is a recorded v1 gap, so the skip-opt is confined to the plan phase where plan.md exists).
  const planFootprint = (repoDir: string): { kind: 'plan'; digest: string } | null => {
    const digest = planDigest(repoDir);
    return digest === '' ? null : { kind: 'plan', digest };
  };
  // §26.10 — price the run's accumulated session-log tokens (main session + subagent logs). Best-effort:
  // any failure degrades to $0 rather than aborting the loop's critical path (CLAUDE.md side-effect rule).
  const iterationCost = (repoDir: string): CostResult => {
    try {
      return priceTokens(readSessionTokens(sessionLogDir(repoDir, process.env, os.homedir())));
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
      clearContext();
      startConsolidateTurn(repoDir, loopName, phase, iteration);
      return;
    }
    activeTurn = { kind: 'reviewers', repoDir, loopName, phase, turnKey: `review-${phase}`, personas: active, iteration };
    turnRunner.requestTurn(activeTurn.turnKey);
  };
  // §26.3/D46 — /clear the hosted instance at an actor boundary. Marking it active synchronously closes
  // the window between this command and the next turn's inject: the turn runner (injectable = quiet)
  // defers, so the deferred prompt only lands after /clear has drained and the instance re-quiesces.
  const clearContext = (): void => {
    inject('/clear', { submit: true });
    agentActivity = 'active';
  };
  // §26.3/D45 — run the consolidate turn: a fresh main-instance turn that reads the fan-out's persona
  // reviews and writes `reviews/<iter>/consolidated.json` with a verdict (advances when that verdict
  // parses; retry-then-error on a missing/malformed one, like every turn).
  const startConsolidateTurn = (repoDir: string, loopName: string, phase: string, iteration: number): void => {
    activeTurn = { kind: 'consolidate', repoDir, loopName, phase, turnKey: `consolidate-${phase}`, iteration };
    turnRunner.requestTurn(activeTurn.turnKey);
  };
  // §26.6/§26.13 L4 — branch on the consolidate verdict (normalized against the bound LoopDef taxonomy):
  // `clean` writes the phase's post-clean gate status and STOPs (awaits the human); `needs-work` writes
  // the next iteration at the phase entry status, /clear-s, and re-runs the work turn.
  const advanceAfterConsolidate = (finished: Extract<ActiveTurn, { kind: 'consolidate' }>): void => {
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
    // §26.6/§26.8 — a needs-work verdict routes to the phase's triage gate (STOP) once phase-2 is active
    // (a prior request-changes), the iteration cap is reached, or the run is flagged stuck.
    const outcome = decideConsolidateOutcome({
      verdict,
      iteration: finished.iteration,
      postCleanGate: phase?.postCleanGate ?? '',
      postNeedsWorkGate: phase?.postNeedsWorkGate ?? '',
      phase2Active: ext.phase2Active,
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
    clearContext();
    startWorkTurn(finished.repoDir, finished.loopName, finished.phase);
  };

  // §26.11 / L8 — auto-resume an interrupted run from <repo>/.agent-loop/state.yaml. Reads the persisted
  // status/iteration + `bound_loop`, computes which of the iteration's turn artifacts already survived, and
  // re-enters the EARLIEST incomplete turn (never re-running a completed one — so a crash mid-fan-out does
  // not re-spawn every reviewer or re-run the work turn), honoring the def's resume_contract `mid_iter_safe`
  // (false rewinds to the iteration start). A gate/terminal/error status is human-owned and not re-driven
  // (the §24.2.3 mirror already presents it). Best-effort: any gap — no state, no bound loop, no
  // resume_contract, or a turn already in flight — is a silent no-op, and it fires at most once per repo.
  const resumedRepos = new Set<string>();
  const resumeLoop = (repoDir: string): void => {
    if (activeTurn !== null || resumedRepos.has(repoDir)) return;
    const s = parseAgentLoopState(repoDir);
    if (!s) return;
    const loopName = readLoopExtension(repoDir).boundLoop;
    if (!loopName) return;
    const def = parseLoopDef(repoDir, loopName);
    if (!def?.resume) return;
    const phase = def.phases.find((p) => p.entryStatus === s.status);
    const roster = phase ? reviewerRosterForPhase(def, phase.id) : [];
    let planPresent = false;
    try {
      planPresent = statSync(path.join(repoDir, '.agent-loop', 'plan.md')).size > 0;
    } catch {
      planPresent = false;
    }
    const decision = decideResume({
      status: s.status,
      iteration: s.iteration,
      phases: def.phases.map((p) => ({ id: p.id, entryStatus: p.entryStatus })),
      midIterSafe: def.resume.midIterSafe,
      artifacts: {
        plan: planPresent,
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
    else
      advanceAfterConsolidate({
        kind: 'consolidate',
        repoDir,
        loopName,
        phase: decision.phaseId,
        turnKey: `consolidate-${decision.phaseId}`,
        iteration: decision.iteration,
      });
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
  const runPickupForStep = (step: FlowStepDef, inputs: Record<string, string>): void => {
    const repoKey = transitioningRepo;
    if (!repoKey || step.kind !== 'loop' || !step.loop) return;
    const def = parseLoopDef(repoKey, step.loop);
    if (!def?.pickup) return; // no pickup_contract → nothing to bootstrap from
    const ticketInput = (step.inputs ?? []).find((i) => i.type === 'github-ticket');
    const raw = ticketInput ? inputs[ticketInput.name] : undefined;
    const issue = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    if (issue === null) return; // cannot bootstrap without a resolved github-ticket issue number
    const loopName = step.loop;
    void runPickup(createRealPickupDeps(repoKey), { repoDir: repoKey, issue, loopName, pickup: def.pickup })
      .then((result) => {
        audit.recordCommand(repoKey, 'pickup', `pickup #${issue}`, result.ok ? 0 : 1);
        pushFlowChanged();
        // §26.3 / L2 — bootstrap done; drive the work-{phase} turn. The phase is the one whose
        // entry_status the freshly-written state.yaml now sits at (the bound def's first phase).
        if (result.ok) {
          const phase = def.phases.find((p) => p.entryStatus === result.status)?.id ?? def.phases[0]?.id;
          if (phase) startWorkTurn(repoKey, loopName, phase);
        }
      });
  };

  // §18.6/§19.3: a manual step's only automatic entry action is injecting its `skill`, refused over a
  // busy shell — a live OSC-133 command span means not at a ready prompt. A `bootstrap: pickup` loop
  // step runs in-app pickup instead (§26.9). Must be built after the injector + tracker exist.
  const flowEntryActions = createFlowEntryActions({
    isShellBusy: () => tracker.summaries().some((s) => s.running),
    inject: (text) => inject(text, { submit: false }),
    runPickup: runPickupForStep,
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
    focusWindow: () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    reveal: () => send(CH.flowRevealLoop, { sessionId: SESSION_ID }),
    notify: ({ title, body, onActivate }) => {
      if (!Notification.isSupported()) return () => {};
      const notification = new Notification({ title, body });
      notification.on('click', onActivate);
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
    const md = loadTodoTemplateFile(path.join(load.flowDir, 'todo-templates'), ref);
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

  const withDerived = (repoKey: string, view: FlowStateView): FlowStateView =>
    deriveFlowView(view, todoStore.list(repoKey), agentActivity);

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
    const step = load.definition.steps[flow.state(repoKey).position - 1];
    return step?.kind === 'loop' && step.loop ? step.loop : null;
  };

  // §26.6 / L5 / D52 — execute the human's gate decision in-app (NOT an injected `/agent-loop-*` command,
  // retired §26.12): resolve the bound LoopDef + the gate at the current status, guard the option against
  // the gate's human_options, then run that option's action list (state write, gh side-effects out of
  // band, human note) and advance/re-iterate/stop. Best-effort: an unresolved gate or an unoffered option
  // is ignored (the loop stays where it is).
  const runGateDecision = (repoKey: string, option: 'approve' | 'request-changes' | 'impasse', note: string): void => {
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
    void executeGateOutcome(
      outcome,
      { repoDir: repoKey, boundLoop: loopName, iteration: s.iteration, pr: s.pr, branch: s.branch, linkedIssues: s.linkedIssues, note: noteText },
      {
        github: createRealGateGitHub(repoKey),
        writeState: (state) => writeLoopState(repoKey, state),
        writeHumanNote: (iteration, text) => writeHumanNote(repoKey, iteration, text),
        // §26.9 / L8 — the epic classification the work-agent wrote into plan.md gates epic-promote.
        readEpicPlan: () => readEpicPlan(repoKey),
        // §26.6 — request-changes re-runs the phase's work turn in a fresh context (the next iteration is
        // already persisted by executeGateOutcome, so the work prompt reads the incremented count).
        reiterate: () => {
          if (reiterPhase) {
            clearContext();
            startWorkTurn(repoKey, loopName, reiterPhase);
          }
        },
      },
    ).then(() => {
      audit.recordCommand(repoKey, 'gate', `gate ${option}`, 0);
      pushFlowChanged();
    });
  };

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee — and, while a loop turn is
  // armed, the done-signal line scanner (§26.3/D47a).
  ptyProcess.onData((data) => {
    outputGate.send(data);
    shadow.write(data);
    turnSentinel.feed(data);
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
      [CH.monitorClearCommands]: (_e, m) => {
        if (isValidClearCommands(m)) tracker.clear();
      },
      [CH.agentInject]: (_e, m) => {
        if (isValidInject(m)) inject(m.text, { submit: m.submit });
      },
      // §26.3/D47a(c) — the operator's manual "this turn is done" override for the in-flight loop turn.
      [CH.flowMarkTurnComplete]: (_e, m) => {
        if (isValidFlowRequest(m)) turnRunner.markComplete();
      },
      // §26.6 / L5 — the human's data-driven gate decision, executed app-internally.
      [CH.flowGateDecision]: (_e, m) => {
        if (isValidFlowGateDecision(m)) runGateDecision(m.repoKey, m.option, m.note ?? '');
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
      [CH.monitorCommands]: (_e, m): CommandSummary[] =>
        isValidCommandsRequest(m)
          ? tracker.summaries().map((s) => ({ ...s, sessionId: SESSION_ID }))
          : [],
      // A command's output text for adding straight to a todo (§16.2); fail-closed to
      // null on a malformed payload or an unknown/trimmed id.
      [CH.monitorCaptureCommandText]: (_e, m): CommandCaptureResult | null =>
        isValidCaptureCommand(m) ? (tracker.capture(m.commandId) ?? null) : null,
      // "Capture last report" (§21.1): returned to the caller, never broadcast — onEvent would prepend
      // a duplicate rather than replace the single slot. Fail-closed to [], which the renderer reads as
      // "nothing captured, keep the prior report" (§6 live-session check).
      [CH.captureLast]: (_e, m) =>
        isValidCaptureLast(m) ? captureLastReport(SESSION_ID, store, scanner) : [],
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
        const templates = load.ok ? listTodoTemplates(path.join(load.flowDir, 'todo-templates')) : [];
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
      () => unwatchTurnDone?.(),
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
