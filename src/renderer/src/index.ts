import { syncDockedPanel } from './dockedPanelSync';
import { createTerminalPane } from './terminal';
import { wireSelection, captureToTodo } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { createFlowStrip, type FlowStrip } from './flowStrip';
import { createLoopPanel, type LoopPanel } from './loopPanel';
import { createFlowInputModal } from './flowInputModal';
import { wireBootstrapConflict } from './wireBootstrapConflict';
import { createConfirmDialog } from './confirmDialog';
import { createErrorDialog } from './errorDialog';
import { createTerminateConfirm } from './terminateConfirm';
import { createStatusBar } from './statusBar';
import { revealLoopReadout } from './loopReveal';
import { createArtifacts, type Artifacts } from './artifacts';
import { renderMarkdownInto, renderCodeInto } from './viewerRender';
import { doInject } from './paneActions';
import { createRepoContext } from './repoContext';
import type { GateDecisionOption } from '../../shared/ipc';
import { createKeymapController, resolveBase } from './keymapController';
import { createKeyboardSettings } from './keyboardSettings';
import { createCliInstall } from './cliInstall';
import { createInstallExamples } from './installExamples';
import { runMenuEditAction } from './menuActions';

const { terminal: term } = createTerminalPane(document.getElementById('terminal')!);
// One shared OSC-7 repo provider (§16.3) so no consumer re-derives the key.
const repo = createRepoContext(window.monitor);

// Keyboard layout (§7.7): one controller holds the active keymap; the terminal dispatch reads it live
// and the settings selector switches it. Starts at the markup default and hydrates from the persisted
// profile once getSettings resolves (a Mac keyboard on Linux can force 'mac' there).
let keyboardUi: { refresh(): void } | undefined;
const keymap = createKeymapController({
  platform: window.term.platform,
  initial: 'auto',
  persist: (p) => window.monitor.setSettings({ keymapProfile: p }),
  persistOverrides: (o) => window.monitor.setSettings({ keymapOverrides: o }),
  onChange: () => keyboardUi?.refresh(),
});
const terminalClipboard = wireSelection(term, () => keymap.current());
// macOS Edit-menu actions (§7.7) route to the terminal's clipboard actions, or a focused input's
// native editing. Off macOS the menu carries no Edit routing, so this never fires.
window.term.onMenuAction((action) => runMenuEditAction(action, document, terminalClipboard, () => window.term.clipboardRead()));
keyboardUi = createKeyboardSettings(document.getElementById('kb-settings-view')!, {
  getProfile: () => keymap.profile(),
  onProfileChange: (p) => keymap.setProfile(p),
  getKeymap: () => keymap.current(),
  getOverrides: () => keymap.overrides(),
  isMac: () => resolveBase(keymap.profile(), window.term.platform) === 'mac',
  onRebind: (action, chord) => keymap.setOverride(action, [chord]),
  onReset: (action) => keymap.clearOverride(action),
});
createCliInstall(document.getElementById('cli-install-view')!, { install: () => window.cli.install() });
createInstallExamples(document.getElementById('install-examples-view')!, {
  preview: () => window.examples.preview(),
  apply: (replace) => window.examples.apply(replace),
});
void window.monitor
  .getSettings()
  .then((s) => {
    // Hydrate persisted overrides first, then the profile (which re-resolves and refreshes the UI).
    for (const [action, chords] of Object.entries(s.keymapOverrides ?? {})) {
      if (chords) keymap.setOverride(action as never, chords);
    }
    keymap.setProfile(s.keymapProfile);
  })
  .catch(() => {}); // a rejected invoke (main restart) must not be an unhandled rejection

wireMonitorPane(repo);

// Forward ref so the shell drives the viewer's full-screen presentation (§20.2) through the
// contract, not a reach-across; the composition root wires it both ways.
let artifacts: Artifacts | undefined;
let flowStrip: FlowStrip | undefined;
const shell = createShell(document.getElementById('app')!, {
  getTheme: () => window.monitor.getSettings().then((s) => s.theme),
  setTheme: (theme) => window.monitor.setSettings({ theme }),
  onViewerFullscreenChange: (on) => artifacts?.setFullscreen(on),
  getKeymap: () => keymap.current(), // §7.7: app-nav chords follow the active profile/overrides
});

wireCrossHighlight(document.getElementById('app')!);

// WCAG 2.4.3.
const landFocus = (): void => {
  if (!flowStrip?.focusLoopReadout()) shell.focusView('1');
};
const errorHost = document.getElementById('flow-error-host');
const errorDialog = errorHost ? createErrorDialog(errorHost, { onFocusLost: landFocus }) : undefined;
if (errorDialog) {
  window.flow.onBootstrapError((reason) => errorDialog.render({ title: 'Bootstrap failed', message: reason }));
  window.flow.onLoopError((reason) => errorDialog.render({ title: 'Loop error', message: reason }));
}

// §22.3.1.
const loopPanelHost = document.getElementById('loop-panel');
let loopPanel: LoopPanel | undefined;
const statusBarHost = document.getElementById('status-bar');
const statusBar = statusBarHost
  ? createStatusBar(statusBarHost, {
      githubRef: (key, kind, number) => window.flow.githubRef(key, kind, number),
      openExternal: (url) => window.flow.openExternal(url),
      setTitle: async (key, text) => void (await window.flow.setTitle(key, text)),
      onAlertActivate: (opener) => {
        shell.openLoopPanel(opener);
        loopPanel?.focusDecision();
      },
      onError: (reason) => errorDialog?.render({ title: 'Could not save the name', message: reason }),
      onOpenError: (reason) => errorDialog?.render({ title: 'Could not open link', message: reason }),
      loopPanelId: loopPanelHost?.id ?? '',
    })
  : undefined;
window.flow.onRevealLoop(() => revealLoopReadout(shell));

// Flow status strip (§22.3 / §24.2.2): the manual-step lifecycle through window.flow, scoped to the
// terminal's current repo (it follows the cwd via the shared repo context, like the todo list).
const flowStripHost = document.getElementById('flow-strip');
if (flowStripHost) {
  // The strip is the single puller of flow state: it hands the loop mirror to the docked loop panel
  // (§24.2.3 T2) through the contract, not a DOM reach-across. No loop → clear + close.
  // The panel resolves ticket/PR detail through window.flow, repo-scoped at call time (the cwd may move
  // between renders), and opens links via the validated openExternal seam (§24.2.3 T7).
  loopPanel = loopPanelHost
    ? createLoopPanel(loopPanelHost, {
        githubRef: (kind, number) => {
          const key = repo.repoKey();
          return key ? window.flow.githubRef(key, kind, number) : Promise.resolve(null);
        },
        openExternal: (url) => void window.flow.openExternal(url),
        markTurnComplete: () => {
          const key = repo.repoKey();
          if (key) window.flow.markTurnComplete(key);
        },
        gateDecision: (option) => {
          const key = repo.repoKey();
          if (key) window.flow.gateDecision(key, option as GateDecisionOption);
        },
        retryTurn: () => {
          const key = repo.repoKey();
          if (key) window.flow.retryTurn(key);
        },
        appRouteOut: (step, turnKey, action) => {
          const key = repo.repoKey();
          if (key) window.flow.appRouteOut(key, step, turnKey, action);
        },
        appGateDecision: (step, turnKey, option) => {
          const key = repo.repoKey();
          if (key) window.flow.appGateDecision(key, step, turnKey, option as GateDecisionOption);
        },
        armInterrupt: (step) => {
          const key = repo.repoKey();
          if (key) window.flow.armInterrupt(key, step);
        },
      })
    : undefined;
  // Same single-puller contract for the typed-input modal (§24.2.3 T3): on a step-entry prompt the
  // strip hands it the prompt + a submit closure; the modal collects values and submit calls provideInput.
  const modalHost = document.getElementById('flow-modal-host');
  const inputModal = modalHost ? createFlowInputModal(modalHost, { onFocusLost: landFocus }) : undefined;
  // Terminate confirmation (#26): a separate destructive modal-dialog organism. The strip hands it the
  // repo + a confirm closure; createTerminateConfirm surfaces the repo's current todo count
  // (window.monitor owns the count — the strip stays flow-only, §9.1) and gates the IPC call.
  const confirmHost = document.getElementById('flow-confirm-host');
  const confirmDialog = confirmHost ? createConfirmDialog(confirmHost, { onFocusLost: landFocus }) : undefined;
  // Bootstrap-conflict confirm (§26.9): main pushes flow:onBootstrapConflict when a re-pickup hit an
  // existing branch under a wipe-and-retry policy. Confirm-first — the wipe is destructive + outward-facing
  // (deletes the branch on origin, closes its PR), so the operator answers a blocking confirm; the answer
  // (wipe / cancel-and-roll-back) rides resolveBootstrapConflict, keyed by the conflict's own repoKey.
  if (confirmDialog) {
    wireBootstrapConflict({
      onBootstrapConflict: (cb) => window.flow.onBootstrapConflict(cb),
      confirm: (opts) => confirmDialog.render(opts),
      resolve: (key, wipe) => window.flow.resolveBootstrapConflict(key, wipe),
    });
  }
  const strip = createFlowStrip(flowStripHost, {
    ...window.flow,
    loopPanelId: loopPanelHost?.id, // instance-scoped aria-controls target
    onPanelState: (loop, title, refs) => {
      syncDockedPanel(loop, title, refs, {
        render: (l, t, r) => loopPanel?.render(l, t, r),
        closePanel: () => shell.closeLoopPanel(),
        syncExpanded: () => shell.syncLoopReadout(),
      });
    },
    onStatusBar: (model, key) => statusBar?.render(model, key),
    onError: (reason) => errorDialog?.render({ title: 'Flow action failed', message: reason }),
    onPrompt: (prompt, stepName, submit) => inputModal?.render(prompt, stepName, submit),
    onTerminate: confirmDialog
      ? createTerminateConfirm({ todoList: window.monitor.todoList, dialog: confirmDialog })
      : undefined,
  });
  flowStrip = strip;
  repo.onChange((info) => strip.onRepoChanged(info.repoKey));
  const seededKey = repo.repoKey();
  if (seededKey !== null) strip.onRepoChanged(seededKey);
}

// View 2 — the artifact viewer (§20.2 / §24.1): real IPC-backed discovery/read scoped to the live
// cwd; a selection routes to two sinks — send (inject, no submit, §9.3) and add-to-todo (§16.2).
const artifactsHost = document.getElementById('artifacts');
if (artifactsHost) {
  const view = createArtifacts(artifactsHost, {
    loadTree: (scope) => window.viewer.tree(scope),
    loadFile: (relPath) => window.viewer.read(relPath),
    renderMarkdown: renderMarkdownInto,
    renderCode: renderCodeInto,
    send: (text) => doInject(text, false),
    addToTodo: (text) => captureToTodo(window.monitor, repo.repoKey(), text),
    onWidthChange: (px) => window.monitor.setSettings({ artifactTreeWidth: px }),
    onFullscreenWidthChange: (px) => window.monitor.setSettings({ artifactFullscreenTreeWidth: px }),
    onRequestFullscreen: (on) => shell.setViewerFullscreen(on),
  });
  artifacts = view;
  repo.onChange(() => void view.refresh());
  // Live reload (§20.1): main watches the tree root and pushes viewer:onChanged when a displayed
  // artifact changes on disk; re-pull so an external edit shows without a cd or manual refresh.
  window.viewer.onChanged(() => void view.refresh());
  // Width restore is kept off the sync repo path so a late getSettings can't make the viewer miss
  // the first cwd:changed broadcast (§20.1).
  void window.monitor
    .getSettings()
    .then((s) => {
      view.setWidth(s.artifactTreeWidth);
      if (s.artifactFullscreenTreeWidth !== undefined) view.setFullscreenWidth(s.artifactFullscreenTreeWidth);
    })
    .catch(() => {}); // a rejected invoke (main restart) keeps the default widths, never rejects
}
