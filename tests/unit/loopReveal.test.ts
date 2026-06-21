// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShell, type Shell } from '../../src/renderer/src/shell';
import { revealLoopReadout } from '../../src/renderer/src/loopReveal';

// §24.2.3 T4 — revealLoopReadout is the renderer's response to the OS-notification activation. It binds
// to the shipped Shell seams; these drive a REAL shell over the app DOM and assert the observable
// landing: viewer-fullscreen exited, the Terminal view active, the docked loop read-out open. The cue
// can never cry "open the gate" only to leave the user on the wrong view or behind hidden chrome.

const APP_HTML = `
<div class="app" id="app">
  <aside class="rail">
    <button class="nav on" data-viewbtn="1">Terminal</button>
    <button class="nav" data-viewbtn="2">Artifacts</button>
    <button class="nav" data-viewbtn="3">Todos</button>
    <span class="stat loopstat" role="button" tabindex="0" aria-expanded="false">Loop</span>
  </aside>
  <aside class="loop-panel" id="loop-panel"><button data-loop-close>x</button></aside>
  <main class="main">
    <div data-viewpane="1" class="on">term</div>
    <div data-viewpane="2">artifacts</div>
    <div data-viewpane="3">todos</div>
  </main>
</div>`;

describe('revealLoopReadout (§24.2.3 T4)', () => {
  let shell: Shell;
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = APP_HTML;
    shell = createShell(document.getElementById('app')!);
  });
  afterEach(() => shell?.dispose());

  it('lands on the Terminal view with the loop read-out open, from another view', () => {
    shell.setView('3');
    expect(shell.getView()).toBe('3');
    revealLoopReadout(shell);
    expect(shell.getView()).toBe('1');
    expect(shell.isLoopPanelOpen()).toBe(true);
  });

  it('opens the read-out when already on the Terminal view with the panel closed', () => {
    expect(shell.getView()).toBe('1');
    expect(shell.isLoopPanelOpen()).toBe(false);
    revealLoopReadout(shell);
    expect(shell.getView()).toBe('1');
    expect(shell.isLoopPanelOpen()).toBe(true);
  });

  it('exits viewer-fullscreen and lands on the Terminal view with the read-out open', () => {
    shell.setView('2');
    shell.setViewerFullscreen(true);
    expect(shell.isViewerFullscreen()).toBe(true);
    revealLoopReadout(shell);
    expect(shell.isViewerFullscreen()).toBe(false);
    expect(shell.getView()).toBe('1');
    expect(shell.isLoopPanelOpen()).toBe(true);
  });
});
