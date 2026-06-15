import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import {
  CH,
  SESSION_ID,
  type ChannelPayloads,
  type CommandCaptureResult,
  type CommandSummary,
  type SendChannel,
} from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createShadowModel } from './shadow';
import { spawnAgentShell } from './pty';
import { createOutputGate } from './outputGate';
import { resolveRendererTarget } from './rendererTarget';
import { installNavigationGuards } from './windowGuards';
import {
  isValidCapture,
  isValidCaptureCommand,
  isValidClearCommands,
  isValidCommandsRequest,
  isValidDismiss,
  isValidDismissAll,
  isValidInject,
  isValidInput,
  isValidLearnChrome,
  isValidResize,
  isValidSetSettings,
  isValidTodoAdd,
  isValidTodoDelete,
  isValidTodoList,
  isValidTodoReorder,
  isValidTodoSetStatus,
  isValidTodoUpdate,
} from './ipcValidation';
import { createTodoStore } from './todoStore';
import { createUiSettingsStore } from './uiSettings';
import { registerIpcListeners } from './sessionIpc';
import { resolveRuntimeConfig } from './runtimeConfig';
import { createCommandTracker } from './commandTracker';
import { createCwdTracker } from './cwdTracker';
import { createScanner } from './scanner';
import { createChromeProfileStore } from './chromeProfile';
import { learnMarkers } from './chrome';
import { createInjectionSuppressor } from './injectionSuppression';
import { createClaudeCodeAdapter } from './adapters/claudeCode';
import { createGenericAdapter } from './adapters/generic';
import { SHELL_INTEGRATION_SCRIPT } from './shellIntegration';

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The preload bridge exposes PTY-writing APIs; the window must never navigate
  // away from the bundled renderer or open child windows (§6, security checklist).
  installNavigationGuards(win.webContents);

  const config = resolveRuntimeConfig(process.env);
  const ptyProcess = await spawnAgentShell({
    integrationScriptPath: config.shellIntegration ? SHELL_INTEGRATION_SCRIPT : undefined,
  });
  const store = createMonitorEventStore();
  // Global UI prefs (§16.6) — the only state outside the repo (userData).
  const uiSettings = createUiSettingsStore(path.join(app.getPath('userData'), 'ui-settings.json'));
  // Repo-scoped todos (§16.3) — persisted in-repo, keyed by the cwd tracker's repo key.
  const todoStore = createTodoStore({ maxDoneTodos: config.maxDoneTodos });
  // Learned chrome markers (§15.x) — seeded defaults ∪ the user's "mark as chrome" adds.
  const chromeProfile = createChromeProfileStore(path.join(app.getPath('userData'), 'chrome-profile.json'));

  const send = <C extends SendChannel>(channel: C, payload: ChannelPayloads[C]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Hold early PTY output until the renderer has registered its pty:data listener (§8.1).
  const outputGate = createOutputGate((data) => send(CH.ptyData, { sessionId: SESSION_ID, data }));

  const shadow = createShadowModel({
    quietMs: config.quietMs,
    onStatus: (status) => send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status }),
  });

  // Command-output capture (§15.5) and the agent-semantic scanner (§15.2/§15.3),
  // both reading only the shadow's public read path — detection only, no autonomy.
  const tracker = createCommandTracker({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    onOsc: (id, cb) => shadow.onOsc(id, cb),
    config,
  });
  // Command history is live off the OSC-133 marks, not §8.3 quiescence (§15.5).
  tracker.onChange(() => send(CH.monitorCommandsChanged, { sessionId: SESSION_ID }));
  // CWD tracking (§16.3): OSC 7 → repo key; broadcast only on key change so the
  // pane swaps its repo-scoped todo list once per `cd` across a repo boundary.
  // TODO(dylan): the full OSC-7 → cwd:changed → repo-list-swap loop through real
  // node-pty + bash is verified in the §F e2e (plan PR5 5c) — recorded gap.
  const cwdTracker = createCwdTracker({ onOsc: (id, cb) => shadow.onOsc(id, cb) });
  cwdTracker.onChange(({ cwd, repoKey }) =>
    send(CH.cwdChanged, { sessionId: SESSION_ID, cwd, repoKey }),
  );
  // Drops echoed self-injected input from re-capture (§16.5): the inject path seeds
  // a watermark; the scanner consults it on the next quiet scan.
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
    onQuiet: (cb) => shadow.onQuiet(cb),
    adapters: config.adapterEnabled('claude-code') ? [createClaudeCodeAdapter()] : [],
    baseline: createGenericAdapter(),
    dedupRetention: config.dedupRetention,
    reportMinChars: config.reportMinChars,
    closedSpans: () => tracker.closedSpans(),
    isSuppressed: (region) => suppressor.isSuppressed(region),
    chromeMarkers: () => chromeProfile.markers(),
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
    // Retraction (§15.3): a later scan superseded an earlier partial capture — drop it
    // from the store (cascading to its findings) so replay won't resurrect it, and tell
    // the pane to remove the block.
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
      // Mark as chrome (§15.x): learn the block's leading glyphs so future furniture is
      // filtered, then retract this capture (cascading to findings) via the shared
      // eventRemoved path so a reloaded pane's replay won't resurrect it.
      [CH.monitorLearnChrome]: (_e, m) => {
        if (!isValidLearnChrome(m)) return;
        chromeProfile.learn(learnMarkers(m.sample));
        store.remove(m.eventId);
        send(CH.monitorEventRemoved, { sessionId: SESSION_ID, eventId: m.eventId });
      },
      // Clear commands (§16.2): drop the whole command history; tracker.onChange
      // notifies the pane to re-pull (now empty).
      [CH.monitorClearCommands]: (_e, m) => {
        if (isValidClearCommands(m)) tracker.clear();
      },
      [CH.agentInject]: (_e, m) => {
        if (isValidInject(m)) inject(m.text, { submit: m.submit });
      },
      // Global UI prefs (§16.6) — no sessionId; persisted to userData.
      [CH.uiSetSettings]: (_e, m) => {
        if (isValidSetSettings(m)) uiSettings.set(m.settings);
      },
    },
    {
      [CH.monitorReplay]: () => store.list(),
      // §16.3: the pane queries the current repo on mount; the live cwd:changed
      // broadcast fires only on key change, so a pane that missed the first OSC 7
      // (emitted before it subscribed) learns the repo key only by asking.
      [CH.monitorCurrentRepo]: () => {
        const cwd = cwdTracker.cwd();
        const repoKey = cwdTracker.repoKey();
        return cwd !== null && repoKey !== null ? { cwd, repoKey } : null;
      },
      [CH.uiGetSettings]: () => uiSettings.get(),
      [CH.monitorCommands]: (_e, m): CommandSummary[] =>
        isValidCommandsRequest(m)
          ? tracker.summaries().map((s) => ({ ...s, sessionId: SESSION_ID }))
          : [],
      // A command's output text for adding straight to a todo (§16.2); fail-closed to
      // null on a malformed payload or an unknown/trimmed id.
      [CH.monitorCaptureCommandText]: (_e, m): CommandCaptureResult | null =>
        isValidCaptureCommand(m) ? (tracker.capture(m.commandId) ?? null) : null,
      // Todo CRUD (§16.4) — each returns the fresh repo list; fail-closed to [] on
      // a malformed payload so a bad message can never mutate another repo's list.
      [CH.todoList]: (_e, m) => (isValidTodoList(m) ? todoStore.list(m.repoKey) : []),
      [CH.todoAdd]: (_e, m) => (isValidTodoAdd(m) ? todoStore.add(m.repoKey, m.text, m.source) : []),
      [CH.todoUpdate]: (_e, m) => (isValidTodoUpdate(m) ? todoStore.update(m.repoKey, m.id, m.text) : []),
      [CH.todoReorder]: (_e, m) => (isValidTodoReorder(m) ? todoStore.reorder(m.repoKey, m.orderedIds) : []),
      [CH.todoSetStatus]: (_e, m) =>
        isValidTodoSetStatus(m) ? todoStore.setStatus(m.repoKey, m.id, m.status) : [],
      [CH.todoDelete]: (_e, m) => (isValidTodoDelete(m) ? todoStore.delete(m.repoKey, m.id) : []),
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
