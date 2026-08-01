import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, shell } from 'electron';
import { applyApplicationMenu, buildMenuTemplate } from './appMenu';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
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
import { createInjector, DEFER_DEADLINE_MS } from './inject';
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
  isValidFlowResolveAppBootstrapConflict,
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
import { createFlowManager, deriveFlowView, loadFlowDefinitionLocalFirst } from './flow';
import { createGithubRefs } from './githubRefs';
import { createAuditRecorder } from './auditRecorder';
import { appBootstrapAuditCmd, appBootstrapAuditExit, type TransitionKind } from '../shared/audit';
import { auditRootDir } from './auditPaths';
import { createFlowEntryActions, injectableSkill } from './flowEntryActions';
import { createLoopBindingPreparer, createRefuseAndRevert } from './loopBinding';
import { migrateBundledLoopDefOnEntry } from './migrateLoopDef';
import { createLoopNotifier } from './loopNotifier';
import { classifyHostedAgent, hostedAgentPresent } from './loopOrchestrator';
import { deriveLoopActivity, type LoopActivity } from '../shared/loopActivity';
import { readTurnDone, watchTurnDone } from './turnDoneFile';
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
  createInstallExamplesCoordinator,
  exampleInstallDirs,
  type InstallDestination,
} from './installExamples';
import { provideAppLoopView } from './loopViewV2';
import { createAppLoopEngine, type AppLoopEntry } from './appLoopEngine';
import { appLoopEntryFor } from './appLoopEntry';
import { armInterrupt, clearAppLoopBootstrap, clearPolish, consolidatorOutputFile, consolidatorOutputRel, enterPolish, isPolishActiveForStep, readAppLoopState, roundReportFile, roundReportRel, writeAppLoopBootstrap, writeAppLoopBootstrapIntent, writeAppLoopState, type AppLoopBootstrap } from './appLoopState';
import { APP_LOOP_DIR_SEGMENTS } from './appLoopPaths';
import { resolveLoopDefV2, type LoopDefV2Context } from './loopDefV2';
import { createRealAppGateGitHub } from './appGateGithub';
import { runAppGateDecision as runAppGateDecisionImpl } from './appGateDecision';
import { probeChainedInput } from './chainedInputProbe';
import { resolveAppLoopDefTiers } from './appLoopDefTiers';
import { createGuardedGateDecision, stepLoopBinding } from './gateDecisionGuard';
import type { CliInstallResult } from '../shared/ipc';
import {
  createAppLoopBootstrapCoordinator,
  createAppLoopBootstrapSession,
  resolveAppGateRefs,
  type AppLoopBootstrapCoordinator,
  type AppLoopBootstrapSession,
} from './appLoopBootstrap';
import { createRealAppBootstrapPorts } from './appBootstrapPorts';

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
  const resolveExampleInstallDestinations = (): InstallDestination[] =>
    exampleInstallDirs(iconLoc, flowGlobalDir);
  const installExamples = createInstallExamplesCoordinator(resolveExampleInstallDestinations);
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
  // §27.2/§27.3 — fired on each active→quiet flip so the app-loop engine can inject a deferred/retry
  // turn the moment the instance is injectable. Assigned once the engine exists (below); a no-op until.
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
      if (status.agentState === 'quiet') notifyInjectable(); // §27.2: the instance is now injectable
    },
  });

  // Capture (§15.5) + scanner (§15.2/§15.3) read only the shadow's public path: detection, no autonomy.
  const tracker = createCommandTracker({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    onOsc: (id, cb) => shadow.onOsc(id, cb),
    config,
  });
  // §27.2 presence (hostedAgentPresent) is derived from the live OSC-133 spans; the classification lives
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

  // §27 activity readout — an in-flight bootstrap (before the app-loop run state exists) feeds the status
  // bar's activity via deriveLoopActivity; not authority, only display. Written by the §27 bootstrap
  // coordinator and cleared when the bootstrap resolves.
  let pickupInFlight: { repoKey: string; issue: number; wipe: boolean } | null = null;
  // §B.5 item 6 / §B.13a — the main-side carrier for a transient notice produced AFTER a transition reply was
  // already sent (the coordinator's asynchronous §19.3 busy-shell refusal). It rides the next `flow:state`
  // response for the repo — consumed one-shot when that view is built — because there is no delivery-ack
  // channel to hang it on. The strip then holds it across passive re-pulls and clears it on the next
  // transition (§B.10). Keyed by repoKey; the receiver never re-derives the target (one payload = one repo).
  const pendingNotice = new Map<string, string>();
  // §27.15 — the §27 (app-namespace) work-turn engine, driving the hosted instance through its own domain
  // ports. Only one turn is ever in flight (one instance). It keeps its run state and done-file in the §27
  // loop area (AC10).
  const appTurnDoneSubdir = path.join(...APP_LOOP_DIR_SEGMENTS);
  let appTurnTimer: ReturnType<typeof setTimeout> | null = null;
  let unwatchAppTurnDone: (() => void) | null = null;
  // §27.15 — one def-resolution context shared by the engine's resolveDef and the §27 gate executor, so both
  // resolve the same def from the same tiers.
  const appDefContext = (repoDir: string): LoopDefV2Context => ({
    tiers: resolveAppLoopDefTiers(iconLoc),
    repoDir,
  });
  let terminateFlowLifecycle: (repoDir: string) => FlowStateView;
  const appEngine = createAppLoopEngine({
    inject: (text) => inject(text, { submit: true }),
    // §27.9/AC6 — the polish stand-down is app-owned loop state in its own file; the engine consults it before
    // running any lever that would re-enter a turn, so the orchestrator stands down until approve ends it. The
    // stand-down identity is single-sourced in `isPolishActiveForStep` (the view's `inPolish` derives from the
    // same predicate) so the two cannot disagree on which step is standing down.
    polishActive: isPolishActiveForStep,
    // §27.9/AC6 — a fresh work-turn entry clears any stale stand-down (see the engine's `enter`), so an abandoned
    // polish cannot resurrect on a later same-step re-drive.
    clearPolish,
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
    inputState: probeChainedInput,
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
    terminateFlow: (repoDir) => void terminateFlowLifecycle(repoDir),
  });
  // Watch the §27 done-file (in the §27 loop area) for the active §27 turn, key-matched so a prior turn's
  // latched file cannot complete a different one (§27.12).
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
  // The §8.3 active→quiet flip is the engine's "instance is now injectable" signal (§27.2) — assigned once
  // the engine exists so the shadow's onStatus (built earlier) can fire it forward.
  notifyInjectable = () => {
    appEngine.onInjectable();
  };
  // Every §8.3 visible-content edge resets the in-flight turn's stall watchdog (§27.12): a streaming turn
  // keeps producing edges so it never stalls, while a frozen screen stops producing them and counts down.
  // Inert unless a turn is in flight (the engine guards it), so this is idle-cheap outside a loop.
  shadow.onActivity(() => {
    appEngine.noteActivity();
  });
  let nextFlowEntryToken = 0;
  const currentFlowEntryTokens = new Map<string, number>();
  let activeFlowEntryOccurrence: { repoKey: string; entry: AppLoopEntry; token: number } | null = null;
  const inTransition = <T>(repoKey: string, entry: AppLoopEntry, fn: () => T): T => {
    const token = ++nextFlowEntryToken;
    const previousToken = currentFlowEntryTokens.get(repoKey);
    currentFlowEntryTokens.set(repoKey, token);
    activeFlowEntryOccurrence = { repoKey, entry, token };
    try {
      return fn();
    } catch (e) {
      if (previousToken === undefined) currentFlowEntryTokens.delete(repoKey);
      else currentFlowEntryTokens.set(repoKey, previousToken);
      throw e;
    } finally {
      activeFlowEntryOccurrence = null;
    }
  };

  // §18.6/§19.3: a manual step's only automatic entry action is injecting its `skill`, refused over a busy
  // shell — a live OSC-133 command span means not at a ready prompt. A loop step binds the §27 engine via the
  // preparer (positions 2/4/5/6) then the dispatch (positions 7/8). Must be built after the injector + tracker.
  let appBootstrapCoordinator: AppLoopBootstrapCoordinator | null = null;
  // §B.5 positions 2/4/5/6 — resolve the bound def, then REFUSE (with the right operator-facing surface) or
  // READY (optionally carrying AC 5's migration notice). The order lives in createLoopBindingPreparer; the
  // effects are wired here to the real resolver, engine, IPC and flow machine (CLAUDE.md injection-seam).
  const prepareLoopBinding = createLoopBindingPreparer({
    resolveDef: (step) => {
      const t = activeFlowEntryOccurrence;
      if (!t || step.loop === undefined) return { ok: false, reason: 'this loop step names no loop to run' };
      return resolveLoopDefV2(step.loop, appDefContext(t.repoKey));
    },
    canEnterWork: () => appEngine.canEnter(),
    // Position 2 — an unresolved def keeps the surviving app-namespace step (reverting would be an AC 2
    // change), so surface the reason on the per-step loop-error path and dispatch nothing.
    refuseUnresolved: (reason) => send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason }),
    // Positions 4/5 — surface the durable bootstrap error, then DEFER an identity-guarded revert + push. The
    // entry action fires inside advance's `enter(view())`, whose reply view was captured at the entered step;
    // a synchronous revert's push would be overwritten by that stale reply, so the revert rides a later tick
    // (mirrors the coordinator's naturally-async rollbackStep guard — entryToken + status + step + issue).
    refuseAndRevert: createRefuseAndRevert({
      activeOccurrence: () =>
        activeFlowEntryOccurrence
          ? { repoKey: activeFlowEntryOccurrence.repoKey, token: activeFlowEntryOccurrence.token }
          : null,
      entryToken: (repoKey) => currentFlowEntryTokens.get(repoKey),
      identity: (repoKey) => {
        const s = flow.state(repoKey);
        return { step: s.stepName, status: s.status, issue: s.refs?.ticket ?? null };
      },
      emitError: (repoKey, step, reason) => send(CH.flowOnBootstrapError, { sessionId: SESSION_ID, repoKey, step, reason }),
      revert: (repoKey, step) => flow.revertStep(repoKey, step),
      push: () => pushFlowChanged(),
      defer: (fn) => setImmediate(fn),
    }),
    // Position 6 — AC 5's def migration, only when the binding resolved from the app-bundled tier and the
    // operator tier exists; the copy is best-effort and returns its one-shot notice (or null).
    migrateIfBundled: (step, resolved) => migrateBundledLoopDefOnEntry(step, resolved, resolveAppLoopDefTiers(iconLoc)),
  });
  const flowEntryActions = createFlowEntryActions({
    isShellBusy: () => tracker.summaries().some((s) => s.running),
    inject: (text) => inject(text, { submit: false }),
    prepareLoopBinding,
    // §B.5 positions 7/8 (AC 10) — dispatch a READY binding. The coordinator injects the step's `skill`
    // (submitted, §19.3-refused on a busy shell) strictly BEFORE the engine boundary on BOTH routes: a
    // no-`pickup` def defers the accepted turn and chains the boundary off the skill's submit; a `pickup` def
    // injects after the bootstrap's work entry. So the seam only forwards the collapsed skill line on the job
    // (CWE-74). The `!resolved.ok`/no-coordinator arm is a defensive direct entry the preparer's position 2
    // has already made unreachable on the live path.
    enterAppLoop: (step) => {
      const t = activeFlowEntryOccurrence;
      if (!t || step.loop === undefined) return;
      const resolved = resolveLoopDefV2(step.loop, appDefContext(t.repoKey));
      const issue = flow.state(t.repoKey).refs?.ticket ?? null;
      if (!resolved.ok || appBootstrapCoordinator === null) {
        appEngine.enter(t.repoKey, step.loop, step.id, t.entry);
        armAppTurnDoneWatch(t.repoKey);
        return;
      }
      appBootstrapCoordinator.enter({
        repoDir: t.repoKey,
        loopName: step.loop,
        stepId: step.id,
        entryToken: t.token,
        entry: t.entry,
        issue,
        bootstrap: resolved.def.pickup,
        ...(step.skill ? { skill: injectableSkill(step.skill) } : {}),
      });
    },
  });
  const flow = createFlowManager({
    globalDir: flowGlobalDir,
    onEnterStep: (step, inputs) => flowEntryActions(step, inputs),
    // §27.15 — the §27 (app-namespace) loop-view provider: resolve the bound app-def across the operator
    // and app-bundled tiers and produce its whole run-less/failure view. Tier roots are chosen by the
    // parsed namespace, never derived from repo content; the loop name is held to a safe segment inside
    // the resolver before any tier root is joined.
    readAppLoopView: (repoKey, name) =>
      provideAppLoopView(appEngine, name, {
        tiers: resolveAppLoopDefTiers(iconLoc),
        repoDir: repoKey,
      }),
  });

  // Flow audit record (§25): observe-only, best-effort — records each run's lifecycle to
  // <app-state home>/.agent-terminal/audit/<repo>/<flow>_<ts>.yaml. The audit tree hangs off the SAME
  // app-state home as the global flow.yaml (flowGlobalDir, APP_HOME_DIR-overridable), never a second
  // home literal. Never throws into the flow path.
  const audit = createAuditRecorder({
    root: auditRootDir(flowGlobalDir),
    now: () => new Date(),
    flowName: (repoKey) => {
      const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
      return load.ok ? load.definition.name : null;
    },
  });

  // TODO(dylanb): §27.12 — after a relaunch this map is empty, so appGateGithub's verifyBootstrap takes its
  // `bootstrap === null` early return and the gate's PR-identity check is silently skipped. The persisted
  // document (readAppLoopBootstrap) cannot simply seed it: resolveAppGateRefs lets a bootstrap OVERRIDE the
  // flow's own refs, and that document is repo-scoped rather than step-scoped, so a stale one retargets
  // `gh pr ready` at another PR. Closing this needs the persisted identity bound to the step it bootstrapped.
  const trustedAppBootstraps = new Map<string, AppLoopBootstrap>();
  const appBootstrapSessions = new Map<string, AppLoopBootstrapSession>();
  const appBootstrapSession = (repoDir: string): AppLoopBootstrapSession => {
    const existing = appBootstrapSessions.get(repoDir);
    if (existing !== undefined) return existing;
    const session = createAppLoopBootstrapSession({
      ...createRealAppBootstrapPorts(repoDir),
      prepareBootstrap: (identity) => writeAppLoopBootstrapIntent(repoDir, identity),
      writeBootstrap: (identity) => writeAppLoopBootstrap(repoDir, identity),
      clearBootstrap: () => clearAppLoopBootstrap(repoDir),
    });
    appBootstrapSessions.set(repoDir, session);
    return session;
  };
  appBootstrapCoordinator = createAppLoopBootstrapCoordinator({
    run: async (repoDir, request) => {
      pickupInFlight = {
        repoKey: repoDir,
        issue: request.issue,
        wipe: request.confirmedWipe !== undefined,
      };
      pushFlowChanged();
      try {
        return await appBootstrapSession(repoDir).run(request);
      } finally {
        if (pickupInFlight?.repoKey === repoDir) pickupInFlight = null;
        pushFlowChanged();
      }
    },
    compensateBootstrap: (job, ownership) =>
      appBootstrapSession(job.repoDir).compensate(ownership),
    finalizeBootstrap: (job, identity) => {
      if (job.issue === null || job.bootstrap === null) return Promise.resolve();
      return appBootstrapSession(job.repoDir).finalize(
        { issue: job.issue, spec: job.bootstrap },
        identity,
      );
    },
    hasBootstrapForJob: (job) => {
      const trusted = trustedAppBootstraps.get(job.repoDir);
      return trusted?.issue === job.issue;
    },
    isCurrentJob: (job) => {
      const current = flow.state(job.repoDir);
      return (
        currentFlowEntryTokens.get(job.repoDir) === job.entryToken &&
        current.status === 'in_progress' &&
        current.stepName === job.stepId &&
        (current.refs?.ticket ?? null) === job.issue
      );
    },
    canEnterWork: () => appEngine.canEnter(),
    acceptBootstrap: (job, identity) =>
      trustedAppBootstraps.set(job.repoDir, identity),
    rollbackStep: (job) => {
      const current = flow.state(job.repoDir);
      if (
        currentFlowEntryTokens.get(job.repoDir) !== job.entryToken ||
        current.status !== 'in_progress' ||
        current.stepName !== job.stepId ||
        (current.refs?.ticket ?? null) !== job.issue
      ) {
        return false;
      }
      flow.revertStep(job.repoDir, job.stepId);
      pushFlowChanged();
      return true;
    },
    enterWork: (repoDir, loopName, stepId, entry, deferRequest) => {
      // §B.20a — with `deferRequest` the engine ACCEPTS the turn (occupying the runner) without requesting it;
      // the coordinator fires `triggerWork` off the skill injection's completion so the boundary preamble is
      // written strictly after the skill's submit (§B.5 item 6, CWE-74). Non-deferred, the turn requests now.
      const result = appEngine.enter(repoDir, loopName, stepId, entry, { deferRequest });
      if (result === 'entered') {
        armAppTurnDoneWatch(repoDir);
        pushFlowChanged();
      }
      return result;
    },
    // §B.13c — inject the collapsed skill line submitted, signalling completion once its submit `\r` is written
    // so the deferred work turn can chain strictly after it (§B.5 item 6).
    inject: (text, onComplete) => inject(text, { submit: true, onComplete }),
    // §19.3 — a live OSC-133 command span means the shell is not at a ready prompt.
    isShellBusy: () => tracker.summaries().some((s) => s.running),
    // §B.5 item 6 / §B.13a — the coordinator's async busy-shell refusal is not an error (the work turn runs
    // fine); stash it on the main-side carrier so it rides the next `flow:state` response for the repo.
    emitNotice: ({ repoDir, notice }) => {
      pendingNotice.set(repoDir, notice);
      pushFlowChanged();
    },
    // §B.20a — request the turn deferred by `enterWork(…, true)`, and abandon one never triggered.
    triggerWork: () => appEngine.triggerDeferredTurn(),
    cancelWork: () => appEngine.cancelDeferredTurn(),
    // §B.20a (CWE-755) — the deadline the deferred turn's skill injection must signal completion within, or the
    // coordinator reverts rather than leave the runner occupied by a turn never requested.
    armDeferDeadline: (onLapse) => {
      const timer = setTimeout(onLapse, DEFER_DEADLINE_MS);
      return () => clearTimeout(timer);
    },
    emitError: ({ repoDir, stepId, reason }) =>
      send(CH.flowOnBootstrapError, {
        sessionId: SESSION_ID,
        repoKey: repoDir,
        step: stepId,
        reason,
      }),
    emitConflict: ({ repoDir, stepId, ...conflict }) =>
      send(CH.flowOnAppBootstrapConflict, {
        sessionId: SESSION_ID,
        repoKey: repoDir,
        step: stepId,
        ...conflict,
      }),
    audit: (repoDir, kind, stepId, detail) =>
      audit.recordCommand(
        repoDir,
        'pickup',
        appBootstrapAuditCmd(kind, stepId, detail),
        appBootstrapAuditExit(kind),
      ),
  });

  // §24.2.3 T7 — resolve a ticket/PR's title/body/url for the popout, best-effort via `gh`, cached.
  const githubRefs = createGithubRefs();

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
    loopNotifier.observe(repoKey, view);
    // §25.5: every view computation observes the loop mirror, so a §27 loop advance is recorded whether it
    // was fired from the strip or reconstructed on a state re-pull.
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

  // §27.10 — the live "what the loop mechanics are doing now" descriptor, derived fresh on every view so a
  // spinner phrase is never stale. Scoped to the repo the view is for. Only the surviving bootstrap (pickup)
  // phrase remains; the retired engine's turn-phase arm is gone (§B.21).
  const loopActivityFor = (repoKey: string): LoopActivity | null =>
    deriveLoopActivity({
      pickup: pickupInFlight?.repoKey === repoKey ? { issue: pickupInFlight.issue, wipe: pickupInFlight.wipe } : null,
    });

  const withDerived = (repoKey: string, view: FlowStateView): FlowStateView => {
    const base = deriveFlowView(view, todoStore.list(repoKey), agentActivity);
    const activity = loopActivityFor(repoKey);
    return activity ? { ...base, loopActivity: activity } : base;
  };

  terminateFlowLifecycle = (repoKey) => {
    const after = flow.terminate(repoKey);
    currentFlowEntryTokens.delete(repoKey);
    trustedAppBootstraps.delete(repoKey);
    audit.recordTerminate(repoKey);
    todoStore.clear(repoKey);
    store.clear();
    send(CH.monitorCleared, { sessionId: SESSION_ID });
    pushFlowChanged();
    return trackLoop(repoKey, withDerived(repoKey, after));
  };

  const withoutTrustedBootstrap = <T>(repoKey: string, transition: () => T): T => {
    const previous = trustedAppBootstraps.get(repoKey);
    trustedAppBootstraps.delete(repoKey);
    try {
      return transition();
    } catch (e) {
      if (previous !== undefined) trustedAppBootstraps.set(repoKey, previous);
      throw e;
    }
  };

  // A flow transition that records its before/after audit diff (§25.5): capture the pre-state, run the
  // mutation inside the bootstrap-attribution window (inTransition), record, then re-derive. Shared by
  // the start/restart/undo handlers, which differ only by kind and mutation; advance/provideInput keep
  // their own bodies because their readiness/notice handling diverges.
  const recordedTransition = (repoKey: string, kind: TransitionKind, mutate: () => FlowStateView): FlowStateView => {
    const before = flow.state(repoKey);
    const after = inTransition(repoKey, appLoopEntryFor(kind), mutate);
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

  // §27.9/§27.13 — advance the flow one step when a loop step's loop reaches a success terminal. Guarded on
  // in_progress (advance throws otherwise, e.g. a flow the operator terminated while the gate resolved) and
  // run inside inTransition so the next step's entry actions fire in transition context, matching the manual
  // advance handler. A no-op guard, never a throw: a raced non-in_progress flow is left untouched.
  const autoAdvanceFlow = (repoKey: string): void => {
    const pre = flow.state(repoKey);
    if (pre.status !== 'in_progress') return;
    const view = inTransition(repoKey, appLoopEntryFor('advance'), () => flow.advance(repoKey));
    audit.recordTransition(repoKey, 'advance', pre, view);
  };

  // §27.9/§27.13 / N5 — composition root for the §27 gate decision. Returns the request-changes
  // delivered/dropped result so the two-way flow:appRequestChanges caller can hold the composer open on a
  // drop (approve goes through the one-way channel and ignores the result).
  const runAppGateDecisionRaw = (repoKey: string, step: string, turnKey: string, option: GateDecisionOption, note?: string): Promise<boolean> =>
    runAppGateDecisionImpl(
      repoKey,
      step,
      turnKey,
      option,
      {
        readRunState: (repoDir) => readAppLoopState(repoDir),
        resolveDef: (repoDir, name) => resolveLoopDefV2(name, appDefContext(repoDir)),
        refs: (repoDir) => {
          return resolveAppGateRefs(
            flow.state(repoDir).refs,
            trustedAppBootstraps.get(repoDir) ?? null,
          );
        },
        runSideEffect: createRealAppGateGitHub(repoKey),
        persistAccept: (repoDir, state) => writeAppLoopState(repoDir, state),
        advanceFlow: (repoDir) => autoAdvanceFlow(repoDir),
        audit: (repoDir, cmd, exit) => audit.recordCommand(repoDir, 'gate', cmd, exit),
        emitError: (reason) => send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason }),
        onViewChanged: () => pushFlowChanged(),
        // §27.9/AC4 — the resume+done-watch preamble mirrors the flowAppRouteOut handler below; both drive a
        // §27 engine that is idle for this repoDir after a relaunch (there is no launch-time §27 resume).
        // TODO(dylanb): the resume-if-not-active leg is deferred coverage, not an untestability exemption — a
        // cold-relaunch-then-request-changes @ownapp test closes it.
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
        // §27.9/AC6 — polish is app-owned loop state written to its own file (§27.9).
        enterPolish: (repoDir, step) => enterPolish(repoDir, step),
        clearPolish: (repoDir) => clearPolish(repoDir),
      },
      note,
    );

  // §B.3/AC 4 — the gate-decision seam refuses a marked binding at the operation: a step that binds no
  // surviving engine (loop_namespace: legacy) never reaches the outward-facing side effect, even if its run
  // state already sits at a verdict. The binding is read from the loaded def by the step id the payload names
  // (§6), never the flow's current position — a marked step the flow has advanced past must still be found.
  const runAppGateDecision = createGuardedGateDecision({
    bindingOf: (repoKey, step) => {
      const load = loadFlowDefinitionLocalFirst(repoKey, flowGlobalDir);
      return load.ok ? stepLoopBinding(load.definition.steps, step) : null;
    },
    refuse: (reason) => send(CH.flowOnLoopError, { sessionId: SESSION_ID, reason }),
    run: runAppGateDecisionRaw,
  });

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee. §27 turn completion is detected
  // via the §27 loop area's turn-done FILE only (§27.12); there is no echo-hazardous line scanner.
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
      // §27.10 — the step and the destroyed resources are both named in the payload, so an answer cannot
      // be applied to a step, or a resource set, the operator was never shown.
      [CH.flowResolveAppBootstrapConflict]: (_e, m) => {
        if (isValidFlowResolveAppBootstrapConflict(m)) {
          appBootstrapCoordinator?.resolve(m.repoKey, m.step, m.wipe, {
            repository: m.repository,
            branch: m.branch,
            localOid: m.localOid,
            remoteOid: m.remoteOid,
            pullRequests: m.pullRequests,
          });
        }
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
      [CH.flowState]: (_e, m) => {
        if (!isValidFlowRequest(m)) return flowRequestError();
        const view = trackLoop(m.repoKey, withDerived(m.repoKey, flow.state(m.repoKey)));
        // §B.5 item 6 / §B.13a — a coordinator-produced async notice (busy shell at hand-off) rides exactly
        // ONE state response: attach it when this view carries none, and consume it so it is not re-sent.
        const pending = pendingNotice.get(m.repoKey);
        if (pending === undefined || view.notice !== undefined) return view;
        pendingNotice.delete(m.repoKey);
        return { ...view, notice: pending };
      },
      [CH.flowStart]: (_e, m) => {
        if (!isValidFlowRequest(m) || !knownRepoKeys.has(m.repoKey)) return flowRequestError();
        return withoutTrustedBootstrap(m.repoKey, () =>
          recordedTransition(m.repoKey, 'start', () => flow.start(m.repoKey)),
        );
      },
      // Advancing while NOT ready is a human override (§19.2): warns via a one-shot notice but still
      // completes. Readiness is read from the PRE-advance state — loop readiness for a loop step, else
      // the todo gate (S5).
      [CH.flowAdvance]: (_e, m) => {
        if (!isValidFlowRequest(m) || !knownRepoKeys.has(m.repoKey)) return flowRequestError();
        const pre = withDerived(m.repoKey, flow.state(m.repoKey));
        const ready = pre.loop ? pre.loop.ready : (pre.derived?.ready ?? true);
        const view = inTransition(m.repoKey, appLoopEntryFor('advance'), () => flow.advance(m.repoKey));
        audit.recordTransition(m.repoKey, 'advance', pre, view);
        if (ready) return trackLoop(m.repoKey, view);
        const notice = pre.loop
          ? 'Advanced while the loop still needs you.'
          : 'Advanced with todos still outstanding.';
        return trackLoop(m.repoKey, { ...view, notice });
      },
      [CH.flowRestart]: (_e, m) => {
        if (!isValidFlowRequest(m) || !knownRepoKeys.has(m.repoKey)) return flowRequestError();
        return withoutTrustedBootstrap(m.repoKey, () =>
          recordedTransition(m.repoKey, 'restart', () => flow.restart(m.repoKey)),
        );
      },
      [CH.flowUndo]: (_e, m) =>
        isValidFlowRequest(m) && knownRepoKeys.has(m.repoKey)
          ? recordedTransition(m.repoKey, 'undo', () => flow.undo(m.repoKey))
          : flowRequestError(),
      // Terminate (#26): inert from not_started / load-error (the control is absent there, AC2) — guard
      // on the pre-state so a malformed/raced request never clears on an error flow. The audit write is
      // best-effort (§25.7) and never blocks the reset (AC5–AC7 hold unconditionally). Per AC9/AC10
      // nothing here signals the terminal process or touches external agent-loop engine state.
      [CH.flowTerminate]: (_e, m) => {
        if (!isValidFlowRequest(m) || !knownRepoKeys.has(m.repoKey)) return flowRequestError();
        const before = flow.state(m.repoKey);
        if (before.status !== 'in_progress' && before.status !== 'done') {
          return trackLoop(m.repoKey, withDerived(m.repoKey, before));
        }
        return terminateFlowLifecycle(m.repoKey);
      },
      // Provide a step's typed input (§18.4 / §24.2.3 T3); the returned view's notice carries any §19.3
      // busy-shell refusal.
      [CH.flowProvideInput]: (_e, m) => {
        if (!isValidFlowProvideInput(m) || !knownRepoKeys.has(m.repoKey)) return flowRequestError();
        const current = flow.state(m.repoKey);
        if (current.status !== 'in_progress' || current.stepName !== m.step) {
          return trackLoop(m.repoKey, withDerived(m.repoKey, current));
        }
        audit.recordInputs(m.repoKey, m.values, inputTypeMap(m.repoKey));
        const view = inTransition(m.repoKey, 're-entry', () => flow.provideInput(m.repoKey, m.values));
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
      // Install bundled examples (§18.1/§23.4/§27.8): bundles resolve build-aware (packaged resources vs
      // the unpackaged app path); the flow lands in the GLOBAL flow home read back by
      // loadFlowDefinitionLocalFirst, and the app loop definitions and commands land in the user-level
      // Claude config directories that the engine and Claude Code discover from.
      [CH.installExamplesPreview]: (_e, m) => installExamples.preview(m),
      [CH.installExamplesApply]: (_e, m) => installExamples.apply(m),
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
        if (appTurnTimer) clearTimeout(appTurnTimer);
      },
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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
