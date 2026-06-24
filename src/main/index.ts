import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification } from 'electron';
import { buildMenuTemplate } from './appMenu';
import path from 'node:path';
import os from 'node:os';
import {
  CH,
  SESSION_ID,
  type AgentState,
  type ChannelPayloads,
  type CommandCaptureResult,
  type CommandSummary,
  type FlowStateView,
  type SendChannel,
} from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createShadowModel } from './shadow';
import { spawnAgentShell, spawnCwd } from './pty';
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
import { createFlowEntryActions } from './flowEntryActions';
import { parseAgentLoopState, watchAgentLoopState } from './agentLoopBridge';
import { createLoopNotifier } from './loopNotifier';
import { parseLoopDef } from './loopDef';
import { listTodoTemplates, loadTodoTemplateFile, parseTodoTemplate } from './todoTemplate';
import { discover, readArtifact, emptyTree } from './artifactTree';
import { createChromeProfileStore } from './chromeProfile';
import { learnMarkers } from './chrome';
import { createInjectionSuppressor } from './injectionSuppression';
import { createClaudeCodeAdapter } from './adapters/claudeCode';
import { createGenericAdapter } from './adapters/generic';
import { SHELL_INTEGRATION_SCRIPT } from './shellIntegration';
import { resolveWindowIconPath, applyDockIcon } from './appIcon';

async function createWindow(): Promise<void> {
  const iconLoc = {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
  // TODO(dylan): app.dock is macOS-only, so this has no Linux e2e — applyDockIcon is unit-covered.
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
  const ptyProcess = await spawnAgentShell({
    integrationScriptPath: config.shellIntegration ? SHELL_INTEGRATION_SCRIPT : undefined,
  });
  const store = createMonitorEventStore();
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
  const pushFlowChanged = (): void => send(CH.flowOnStateChanged, { sessionId: SESSION_ID });

  // Hold early PTY output until the renderer registers its pty:data listener (§8.1).
  const outputGate = createOutputGate((data) => send(CH.ptyData, { sessionId: SESSION_ID, data }));

  const shadow = createShadowModel({
    quietMs: config.quietMs,
    onStatus: (status) => {
      agentActivity = status.agentState;
      send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status });
      pushFlowChanged(); // the active↔quiet flip moves the strip's derived activity (§24.2.2 S5)
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
  const viewerCwd = (): string => cwdTracker.cwd() ?? spawnCwd(process.env, os.homedir());
  cwdTracker.onChange(({ cwd, repoKey }) =>
    send(CH.cwdChanged, { sessionId: SESSION_ID, cwd, repoKey }),
  );
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
    write: (data) => ptyProcess.write(data),
    isBracketedPaste: () => shadow.isBracketedPaste(),
    onInject: () => suppressor.noteInjection(),
  });

  // §18.6/§19.3: a manual step's only automatic entry action is injecting its `skill`, refused over a
  // busy shell — a live OSC-133 command span means not at a ready prompt. Must be built after the
  // injector + tracker exist (it closes over both).
  const flowEntryActions = createFlowEntryActions({
    isShellBusy: () => tracker.summaries().some((s) => s.running),
    inject: (text) => inject(text, { submit: false }),
  });
  // The same global fallback dir the definition uses, so on-demand template instantiation (§18.6)
  // resolves against a global flow's templates too.
  const flowGlobalDir = spawnCwd(process.env, os.homedir());
  const flow = createFlowManager({
    globalDir: flowGlobalDir,
    onEnterStep: (step, inputs) => flowEntryActions(step, inputs),
    readLoopState: (repoKey) => parseAgentLoopState(repoKey),
    readLoopDef: (repoKey, name) => parseLoopDef(repoKey, name),
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
    if (view.loop && !loopWatchers.has(repoKey)) {
      loopWatchers.set(repoKey, watchAgentLoopState(repoKey, pushFlowChanged));
    }
    loopNotifier.observe(repoKey, view);
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

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee.
  ptyProcess.onData((data) => {
    outputGate.send(data);
    shadow.write(data);
  });
  ptyProcess.onExit(({ exitCode }) => send(CH.ptyExit, { sessionId: SESSION_ID, code: exitCode }));

  const disposeIpc = registerIpcListeners(
    ipcMain,
    {
      [CH.ptyInput]: (_e, m) => {
        if (isValidInput(m)) ptyProcess.write(m.data);
      },
      // PTY and shadow must never diverge in size, or captures mis-wrap (§4 flow F).
      [CH.ptyResize]: (_e, m) => {
        if (isValidResize(m)) {
          ptyProcess.resize(m.cols, m.rows);
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
        currentRepoInfo(cwdTracker.cwd(), cwdTracker.repoKey(), spawnCwd(process.env, os.homedir())),
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
        const list = todoStore.add(m.repoKey, m.text, m.source);
        pushFlowChanged();
        return list;
      },
      [CH.todoUpdate]: (_e, m) => (isValidTodoUpdate(m) ? todoStore.update(m.repoKey, m.id, m.text) : []),
      [CH.todoReorder]: (_e, m) => (isValidTodoReorder(m) ? todoStore.reorder(m.repoKey, m.orderedIds) : []),
      [CH.todoSetStatus]: (_e, m) => {
        if (!isValidTodoSetStatus(m)) return [];
        const list = todoStore.setStatus(m.repoKey, m.id, m.status);
        pushFlowChanged();
        return list;
      },
      [CH.todoDelete]: (_e, m) => {
        if (!isValidTodoDelete(m)) return [];
        const list = todoStore.delete(m.repoKey, m.id);
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
        isValidFlowRequest(m) ? trackLoop(m.repoKey, withDerived(m.repoKey, flow.start(m.repoKey))) : flowRequestError(),
      // Advancing while NOT ready is a human override (§19.2): warns via a one-shot notice but still
      // completes. Readiness is read from the PRE-advance state — loop readiness for a loop step, else
      // the todo gate (S5).
      [CH.flowAdvance]: (_e, m) => {
        if (!isValidFlowRequest(m)) return flowRequestError();
        const pre = withDerived(m.repoKey, flow.state(m.repoKey));
        const ready = pre.loop ? pre.loop.ready : (pre.derived?.ready ?? true);
        const view = flow.advance(m.repoKey);
        if (ready) return trackLoop(m.repoKey, view);
        const notice = pre.loop
          ? 'Advanced while the loop still needs you.'
          : 'Advanced with todos still outstanding.';
        return trackLoop(m.repoKey, { ...view, notice });
      },
      [CH.flowRestart]: (_e, m) =>
        isValidFlowRequest(m) ? trackLoop(m.repoKey, withDerived(m.repoKey, flow.restart(m.repoKey))) : flowRequestError(),
      [CH.flowUndo]: (_e, m) =>
        isValidFlowRequest(m) ? trackLoop(m.repoKey, withDerived(m.repoKey, flow.undo(m.repoKey))) : flowRequestError(),
      // Provide a step's typed input (§18.4 / §24.2.3 T3); the returned view's notice carries any §19.3
      // busy-shell refusal.
      [CH.flowProvideInput]: (_e, m) =>
        isValidFlowProvideInput(m)
          ? trackLoop(m.repoKey, withDerived(m.repoKey, flow.provideInput(m.repoKey, m.values)))
          : flowRequestError(),
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
        const list = instantiateTemplate(m.repoKey, m.ref);
        pushFlowChanged(); // instantiation can add todos → the strip's n/m total moves (§24.2.2 S5)
        return list;
      },
    },
  );

  win.on('closed', () => {
    disposeIpc();
    ptyProcess.kill();
    scanner.dispose();
    suppressor.dispose();
    cwdTracker.dispose();
    tracker.dispose();
    shadow.dispose();
    for (const stop of loopWatchers.values()) stop();
    loopWatchers.clear();
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
