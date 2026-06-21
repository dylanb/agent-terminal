import { createTerminalPane } from './terminal';
import { wireSelection, captureToTodo } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { SAMPLE_FLOW, createGatePanel } from './flow';
import { createFlowStrip } from './flowStrip';
import { createLoopPanel } from './loopPanel';
import { createFlowInputModal } from './flowInputModal';
import { createArtifacts, type Artifacts } from './artifacts';
import { renderMarkdownInto, renderCodeInto } from './viewerRender';
import { doInject } from './paneActions';
import { createRepoContext } from './repoContext';

const { terminal: term } = createTerminalPane(document.getElementById('terminal')!);
// One shared OSC-7 repo provider (§16.3): seeds the repo key once and feeds the terminal
// selection capture, the todo list, and the artifact viewer — so no consumer re-derives it.
const repo = createRepoContext(window.monitor);
wireSelection(term, repo);
wireMonitorPane(repo);

// The converged three-view shell (§24.1C): view switching, hotkeys, the docked
// quick-send drawer, and the theme — with theme persisted through the global
// UI-settings seam (§16.6). The drawer hosts the reused action window; no scrim,
// so the terminal stays visible for cross-highlight (§16.8, §22.2 amendment).
// Forward ref so the shell can drive the viewer's full-screen presentation (§20.2) without
// reaching across organisms — the composition root wires the contract both ways.
let artifacts: Artifacts | undefined;
const shell = createShell(document.getElementById('app')!, {
  getTheme: () => window.monitor.getSettings().then((s) => s.theme),
  setTheme: (theme) => window.monitor.setSettings({ theme }),
  onViewerFullscreenChange: (on) => artifacts?.setFullscreen(on),
});

// Cross-highlight wiring for any finding/source pairs that carry a data-find id
// (the mocked artifact/finding markup today; real provenance spans in a later phase).
wireCrossHighlight(document.getElementById('app')!);

// Flow status strip (§22.3 / §24.2.2): the manual-step lifecycle driven through window.flow,
// scoped to the terminal's current repo. Like the todo list, it follows the cwd — the shared
// repo context delivers the seeded key on mount and every subsequent cd, and the strip re-pulls.
const flowStripHost = document.getElementById('flow-strip');
if (flowStripHost) {
  // The docked loop panel (§24.2.3 T2) is a sibling organism in its own grid column. The strip is
  // the single puller of flow state; it hands the current loop mirror to the panel here (the contract
  // seam, not a DOM reach-across), and the shell docks/undocks the column. No loop → clear + close.
  const loopPanelHost = document.getElementById('loop-panel');
  const loopPanel = loopPanelHost ? createLoopPanel(loopPanelHost) : undefined;
  // The typed-input modal (§24.2.3 T3) is a sibling organism over its own fixed host. The strip is the
  // single puller of flow state; on a step-entry prompt it hands the prompt + a submit closure here
  // (the contract seam, not a DOM reach-across); the modal collects values and submit calls provideInput.
  const modalHost = document.getElementById('flow-modal-host');
  const inputModal = modalHost ? createFlowInputModal(modalHost) : undefined;
  const flowStrip = createFlowStrip(flowStripHost, {
    ...window.flow,
    loopPanelId: loopPanelHost?.id, // inject the controlled panel id (instance-scoped aria-controls)
    onLoopState: (loop, title) => {
      loopPanel?.render(loop, title);
      if (!loop) {
        shell.closeLoopPanel(); // the read-out is gone; never leave an empty panel docked
      } else {
        // The strip just re-rendered a fresh .loopstat (default aria-expanded=false); if the panel
        // is open, re-sync the read-out so it doesn't read collapsed while the column is docked.
        document.querySelector('.loopstat')?.setAttribute('aria-expanded', String(shell.isLoopPanelOpen()));
      }
    },
    onPrompt: (prompt, stepName, submit) => inputModal?.render(prompt, stepName, submit),
  });
  repo.onChange((info) => flowStrip.onRepoChanged(info.repoKey));
  const seededKey = repo.repoKey();
  if (seededKey !== null) flowStrip.onRepoChanged(seededKey);
}

// View-3 Review gate (§19.3) is still a fixture-driven, stubbed mock — out of S1 scope.
const gatePanel = document.getElementById('gate-panel');
if (gatePanel) createGatePanel(gatePanel, SAMPLE_FLOW);

// View 2 — the artifact viewer (§20.2 / §24.1): real IPC-backed discovery/read
// (`viewer:tree` / `viewer:read`, scoped to the session's live cwd) rendered with the
// real markdown-it+mermaid / CodeMirror stack; a selection routes to the same two sinks as
// the terminal-pane selection — send-to-agent (inject, no submit, §9.3) and add-to-todo (§16.2).
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
  // Re-discover when the agent cd's into another repo/dir (the shared context already holds
  // the seeded key for add-to-todo).
  repo.onChange(() => void view.refresh());
  // Apply the persisted tree width once settings resolve (kept off the sync path above so a
  // late getSettings can't make the viewer miss the first cwd:changed broadcast, §20.1).
  void window.monitor
    .getSettings()
    .then((s) => {
      view.setWidth(s.artifactTreeWidth);
      if (s.artifactFullscreenTreeWidth !== undefined) view.setFullscreenWidth(s.artifactFullscreenTreeWidth);
    })
    // A rejected invoke (main restart) keeps the default computed widths; never an unhandled
    // rejection (mirrors the tested monitor.ts getSettings catch).
    .catch(() => {});
}
