import { createTerminalPane } from './terminal';
import { wireSelection, captureToTodo } from './selection';
import { wireMonitorPane } from './monitor';
import { createShell } from './shell';
import { wireCrossHighlight } from './crossHighlight';
import { SAMPLE_FLOW, createGatePanel } from './flow';
import { createFlowStrip, type FlowStrip } from './flowStrip';
import { createLoopPanel } from './loopPanel';
import { createFlowInputModal } from './flowInputModal';
import { createAttentionCue } from './attentionCue';
import { revealLoopReadout } from './loopReveal';
import { createArtifacts, type Artifacts } from './artifacts';
import { renderMarkdownInto, renderCodeInto } from './viewerRender';
import { doInject } from './paneActions';
import { createRepoContext } from './repoContext';

const { terminal: term } = createTerminalPane(document.getElementById('terminal')!);
// One shared OSC-7 repo provider (§16.3) so no consumer re-derives the key.
const repo = createRepoContext(window.monitor);
wireSelection(term, repo);
wireMonitorPane(repo);

// Forward ref so the shell drives the viewer's full-screen presentation (§20.2) through the
// contract, not a reach-across; the composition root wires it both ways.
let artifacts: Artifacts | undefined;
// Forward ref: the cue's dismiss handler (built first) lands focus via the strip's typed seam below.
let flowStrip: FlowStrip | undefined;
const shell = createShell(document.getElementById('app')!, {
  getTheme: () => window.monitor.getSettings().then((s) => s.theme),
  setTheme: (theme) => window.monitor.setSettings({ theme }),
  onViewerFullscreenChange: (on) => artifacts?.setFullscreen(on),
});

wireCrossHighlight(document.getElementById('app')!);

// Awaiting-human attention cue (§24.2.3 T4): the flow strip feeds it the loop mirror (below); the
// OS notification's activation pushes flow:revealLoop, answered by revealLoopReadout via Shell seams.
const attnCueHost = document.getElementById('attn-cue');
const attentionCue = attnCueHost
  ? createAttentionCue(attnCueHost, {
      // WCAG 2.4.3: never strand focus on <body>; the composition root owns this cross-organism fallback.
      onDismiss: () => {
        if (!flowStrip?.focusLoopReadout()) shell.focusView('1');
      },
    })
  : undefined;
window.flow.onRevealLoop(() => revealLoopReadout(shell));

// Flow status strip (§22.3 / §24.2.2): the manual-step lifecycle through window.flow, scoped to the
// terminal's current repo (it follows the cwd via the shared repo context, like the todo list).
const flowStripHost = document.getElementById('flow-strip');
if (flowStripHost) {
  // The strip is the single puller of flow state: it hands the loop mirror to the docked loop panel
  // (§24.2.3 T2) through the contract, not a DOM reach-across. No loop → clear + close.
  const loopPanelHost = document.getElementById('loop-panel');
  const loopPanel = loopPanelHost ? createLoopPanel(loopPanelHost) : undefined;
  // Same single-puller contract for the typed-input modal (§24.2.3 T3): on a step-entry prompt the
  // strip hands it the prompt + a submit closure; the modal collects values and submit calls provideInput.
  const modalHost = document.getElementById('flow-modal-host');
  const inputModal = modalHost ? createFlowInputModal(modalHost) : undefined;
  const strip = createFlowStrip(flowStripHost, {
    ...window.flow,
    loopPanelId: loopPanelHost?.id, // instance-scoped aria-controls target
    onLoopState: (loop, title) => {
      loopPanel?.render(loop, title);
      attentionCue?.render(loop ?? null, repo.repoKey());
      if (!loop) {
        shell.closeLoopPanel(); // the read-out is gone; never leave an empty panel docked
      } else {
        // The strip re-rendered a fresh .loopstat (default aria-expanded=false); re-sync it to the
        // docked state so an open panel doesn't read collapsed (WAI-ARIA).
        document.querySelector('.loopstat')?.setAttribute('aria-expanded', String(shell.isLoopPanelOpen()));
      }
    },
    onPrompt: (prompt, stepName, submit) => inputModal?.render(prompt, stepName, submit),
  });
  flowStrip = strip;
  repo.onChange((info) => strip.onRepoChanged(info.repoKey));
  const seededKey = repo.repoKey();
  if (seededKey !== null) strip.onRepoChanged(seededKey);
}

// View-3 Review gate (§19.3) is still a fixture-driven, stubbed mock — out of S1 scope.
const gatePanel = document.getElementById('gate-panel');
if (gatePanel) createGatePanel(gatePanel, SAMPLE_FLOW);

// View 2 — the artifact viewer (§20.2 / §24.1): real IPC-backed discovery/read scoped to the live
// cwd; a selection routes to the same two sinks as the terminal pane — send (inject, no submit,
// §9.3) and add-to-todo (§16.2).
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
