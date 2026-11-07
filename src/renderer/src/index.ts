import { syncDockedPanel } from './dockedPanelSync';
import { createTerminalPane } from './terminal';
import { wireSelection, captureToTodo } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { createFlowStrip, type FlowStrip } from './flowStrip';
import type { FlowViewArgs } from './flowView';
import { createFlowPicker } from './flowPicker';
import { createPickupConfirm } from './pickupConfirm';
import { createSetupCheckDialog } from './setupCheckDialog';
import { createSetupFlowRun } from './setupFlowRun';
import { createLoopPanel, type LoopPanel } from './loopPanel';
import { createFlowInputModal } from './flowInputModal';
import { createFeedbackComposer } from './feedbackComposer';
import { createRedoComposer } from './redoComposer';
import { wireAppBootstrapConflict } from './wireAppBootstrapConflict';
import { wireEpicPromotion } from './wireEpicPromotion';
import { createConfirmDialog } from './confirmDialog';
import { createErrorDialog, type ErrorDialogOptions } from './errorDialog';
import {
  createTerminateConfirm,
  handleTerminateRepoChange,
} from './terminateConfirm';
import {
  createFlowModalCoordinator,
  type FlowModalCoordinator,
} from './flowModalCoordinator';
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
import { createCliInstallAction } from './cliInstallAction';
import { createInstallExamples } from './installExamples';
import { runMenuEditAction } from './menuActions';

const stopIncompatible = window.term.startup.onIncompatible(({ update, terminalVersion, controllerVersions: { min, max } }) => {
  const supported = min === max ? `version ${min}` : `versions ${min}–${max}`;
  const action = update === 'controller'
    ? 'Update Agent Terminal Controller, then restart it.'
    : 'Update Agent Terminal, then open this terminal again.';
  const message = document.getElementById('startup-incompatible')!;
  message.textContent = `This terminal uses controller protocol version ${terminalVersion}, but the running controller supports ${supported}. ${action}`;
});

createCliInstallAction(document.getElementById('startup-cli-install')!, { install: () => window.cli.install() });

void window.term.startup.ready().then(() => {
  stopIncompatible();
  document.getElementById('startup-waiting')!.hidden = true;
  document.getElementById('app')!.hidden = false;
  initialize();
  window.term.startup.rendered();
});

function initialize(): void {
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
const installExamples = createInstallExamples(document.getElementById('install-examples-view')!, {
  preview: () => window.examples.preview(),
  apply: (previewId, replace, removeRetired) =>
    window.examples.apply(previewId, replace, removeRetired),
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
let flowModals: FlowModalCoordinator | undefined;
const showError = (options: ErrorDialogOptions): void => {
  if (flowModals) flowModals.showError(options);
  else errorDialog?.render(options);
};
if (errorDialog) {
  window.flow.onBootstrapError((reason, repoKey, step) =>
    showError({
      title: `Bootstrap failed — ${step}`,
      message: `${reason}\n\nRepository: ${repoKey}`,
    }),
  );
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
      onError: (reason) => showError({ title: 'Could not save the name', message: reason }),
      onOpenError: (reason) => showError({ title: 'Could not open link', message: reason }),
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
  // §27.9/AC4 — the request-changes feedback composer: a §27 gate request-changes opens it (below), and its
  // submit dispatches the decision carrying the composed feedback. Repo-scoped at composer-open time (bind to
  // the gate the operator saw, §6). Absent host → no composer, so the loop panel renders no request-changes
  // button at all (approve remains the route out) rather than an inert control.
  const composerHost = document.getElementById('feedback-composer-host');
  const feedbackComposer = composerHost ? createFeedbackComposer(composerHost, { onFocusLost: landFocus }) : undefined;
  // §27.9/AC5 — the redo instruction composer: a §27 gate redo opens it (below), and its submit dispatches the
  // two-way redo decision carrying the typed instruction. Absent host → no composer, so the loop panel renders
  // no redo button (approve/request-changes remain) rather than an inert control.
  const redoComposerHost = document.getElementById('redo-composer-host');
  const redoComposer = redoComposerHost ? createRedoComposer(redoComposerHost, { onFocusLost: landFocus }) : undefined;
  const confirmHost = document.getElementById('flow-confirm-host');
  const confirmDialog = confirmHost ? createConfirmDialog(confirmHost, { onFocusLost: landFocus }) : undefined;
  const requestTerminate = confirmDialog
    ? createTerminateConfirm({ todoList: window.monitor.todoList, dialog: confirmDialog })
    : undefined;
  if (confirmDialog) {
    flowModals = createFlowModalCoordinator({
      errors: errorDialog,
      confirmations: confirmDialog,
      cancelPendingConfirmation: () => requestTerminate?.cancelPending(),
    });
    wireAppBootstrapConflict({
      onConflict: (cb) => window.flow.onAppBootstrapConflict(cb),
      confirm: (opts) => flowModals!.showConfirmation(opts),
      resolve: (key, step, wipe, target) =>
        window.flow.resolveAppBootstrapConflict(key, step, wipe, target),
    });
    wireEpicPromotion({
      onPreview: (cb) => window.flow.onEpicPromotionPreview(cb),
      confirm: (opts) => flowModals!.showConfirmation(opts),
      resolve: (key, step, confirm) => window.flow.resolveEpicPromotion(key, step, confirm),
    });
  }
  loopPanel = loopPanelHost
    ? createLoopPanel(loopPanelHost, {
        githubRef: (kind, number) => {
          const key = repo.repoKey();
          return key ? window.flow.githubRef(key, kind, number) : Promise.resolve(null);
        },
        openExternal: (url) => window.flow.openExternal(url),
        appRouteOut: (step, turnKey, action) => {
          const key = repo.repoKey();
          if (!key) return;
          if (action === 'terminate') {
            requestTerminate?.(key, () =>
              window.flow.appRouteOut(key, step, turnKey, action),
              document.activeElement as HTMLElement | null,
            );
            return;
          }
          window.flow.appRouteOut(key, step, turnKey, action);
        },
        appGateDecision: (step, turnKey, option) => {
          const key = repo.repoKey();
          if (key) return window.flow.appGateDecision(key, step, turnKey, option as GateDecisionOption);
        },
        // §27.9/AC4 — request-changes opens the composer; its submit dispatches the two-way decision and the
        // composer holds open until it resolves (true → close, false → keep the feedback for a retry). Wired
        // only when the composer exists; on a build without the host the panel renders no request-changes button.
        composeFeedback: feedbackComposer
          ? (step, turnKey) => {
              const key = repo.repoKey();
              if (!key) return;
              const dispatch = (feedback: string): Promise<boolean> => window.flow.appRequestChanges(key, step, turnKey, feedback);
              // §19.4 — surface the repo's active review todos to curate; a fetch failure/empty just yields a
              // free-text-only composer (best-effort, never blocks the request-changes path).
              void window.monitor
                .todoList(key)
                .then((todos) => todos.filter((t) => t.status !== 'done').map((t) => ({ id: t.id, text: t.text })))
                .catch(() => [] as Array<{ id: string; text: string }>)
                .then((todos) => feedbackComposer.render({ step, todos }, dispatch));
            }
          : undefined,
        // §27.9/AC5 — redo opens the instruction composer; its submit dispatches the two-way decision and the
        // composer holds open until it resolves (true → close, false → keep the instruction for a retry). Wired
        // only when the composer exists; on a build without the host the panel renders no redo button.
        composeRedo: redoComposer
          ? (step, turnKey) => {
              const key = repo.repoKey();
              if (!key) return;
              const dispatch = (instruction: string): Promise<boolean> => window.flow.appRedo(key, step, turnKey, instruction);
              redoComposer.render({ step }, dispatch);
            }
          : undefined,
        // §28.4.2 — Back to RED opens the same composer as request-changes, framed for an optional slice brief; its
        // submit dispatches the two-way decision and the composer holds open until the flow is back at its return step.
        composeBackToRed: feedbackComposer
          ? (step, turnKey, target) => {
              const key = repo.repoKey();
              if (!key) return;
              const dispatch = (brief: string): Promise<boolean> => window.flow.appBackToRed(key, step, turnKey, brief);
              void window.monitor
                .todoList(key)
                .then((todos) => todos.filter((t) => t.status !== 'done').map((t) => ({ id: t.id, text: t.text })))
                .catch(() => [] as Array<{ id: string; text: string }>)
                .then((todos) => feedbackComposer.render({ step, todos, purpose: 'back-to-red', target }, dispatch));
            }
          : undefined,
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
  // §22.3 / §22.4 — a second flow:state caller would consume the one-shot pending notice meant for the strip.
  const viewListeners = new Set<(...args: FlowViewArgs) => void>();
  const pickerHost = document.getElementById('flow-picker');
  if (pickerHost) createFlowPicker(pickerHost, {
    onView: (cb) => {
      viewListeners.add(cb);
      return () => viewListeners.delete(cb);
    },
    listCatalog: (key) => window.flow.listCatalog(key),
    select: (key, id) => window.flow.setActiveFlow(key, id),
    clearSelection: (key) => window.flow.clearActiveFlow(key),
    rebindHeldRun: (key, choice, ifStepMissing) => window.flow.rebindHeldRun(key, choice, ifStepMissing),
    confirmEndRun: (key, proceed, restoreFocusTo) => requestTerminate?.(key, proceed, restoreFocusTo),
  });
  const pickupConfirmHost = document.getElementById('pickup-confirm');
  const pickupConfirmModalHost = document.getElementById('pickup-confirm-modal-host');
  if (pickupConfirmHost && pickupConfirmModalHost) createPickupConfirm(pickupConfirmHost, {
    modalHost: pickupConfirmModalHost,
    onView: (cb) => {
      viewListeners.add(cb);
      return () => viewListeners.delete(cb);
    },
    confirm: (key, run, pr, ticket) => window.flow.confirmRunPickup(key, run, pr, ticket),
    onFocusLost: landFocus,
  });
  const strip = createFlowStrip(flowStripHost, {
    ...window.flow,
    onView: (...args) => {
      for (const listener of [...viewListeners]) listener(...args);
    },
    loopPanelId: loopPanelHost?.id, // instance-scoped aria-controls target
    onPanelState: (loop, title, refs) => {
      syncDockedPanel(loop, title, refs, {
        render: (l, t, r) => loopPanel?.render(l, t, r),
        closePanel: () => shell.closeLoopPanel(),
        syncExpanded: () => shell.syncLoopReadout(),
      });
    },
    onStatusBar: (model, key) => statusBar?.render(model, key),
    onError: (reason) => showError({ title: 'Flow action failed', message: reason }),
    onPrompt: (prompt, stepName, submit) => inputModal?.render(prompt, stepName, submit),
    onTerminate: requestTerminate
      ? (key, confirm) =>
          requestTerminate(
            key,
            confirm,
            document.activeElement as HTMLElement | null,
          )
      : undefined,
  });
  flowStrip = strip;
  repo.onChange((info) => {
    flowModals?.cancelConfirmation();
    handleTerminateRepoChange(
      requestTerminate,
      info.repoKey,
      (repoKey) => strip.onRepoChanged(repoKey),
      {
        isAffected: () => {
          const active = document.activeElement;
          return (
            active !== null &&
            (flowStripHost.contains(active) ||
              (pickerHost?.contains(active) ?? false) ||
              (confirmHost?.contains(active) ?? false))
          );
        },
        land: landFocus,
      },
    );
  });
  const seededKey = repo.repoKey();
  if (seededKey !== null) strip.onRepoChanged(seededKey);
}

const setupCheckHost = document.getElementById('setup-check-host');
if (setupCheckHost) {
  const setupCheck = createSetupCheckDialog(setupCheckHost, {
    status: (repoKey) => window.setup.status(repoKey),
    dismiss: (dismissal) => window.setup.dismiss(dismissal),
    openInstallExamples: () => {
      shell.setView('4');
      installExamples.open();
    },
    runSetupFlow: createSetupFlowRun({
      setActiveFlow: (repoKey, id) => window.flow.setActiveFlow(repoKey, id),
      start: (repoKey) => flowStrip?.start(repoKey) ?? Promise.resolve(),
    }),
    announce: (title, message) => showError({ title, message }),
    onFocusLost: landFocus,
    blockingDialogOpen: () => shell.modalIsOpen(),
    onBlockingDialogClosed: (cb) => shell.onModalClosed(cb),
  });
  repo.onChange((info) => void setupCheck.check(info.repoKey));
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

}
