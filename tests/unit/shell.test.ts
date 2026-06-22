// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShell, type Shell } from '../../src/renderer/src/shell';
import { FOCUS_VIEW_EVENT, FOCUS_TERMINAL_EVENT } from '../../src/renderer/src/paneActions';
import { resolveKeymap } from '../../src/shared/keymap';

// The converged shell (§22.4 / §24.1C): slim left rail + three view panes + a
// docked drawer. These tests drive the controller through its public interface and
// assert only what a user can observe — which pane/nav/tab is active, whether the
// drawer is docked, the theme attribute — never how it's wired internally.

const SHELL_HTML = `
<div class="app drawer-open" id="app">
  <aside class="rail">
    <button class="nav on" data-viewbtn="1">Terminal</button>
    <button class="nav" data-viewbtn="2">Artifacts</button>
    <button class="nav" data-viewbtn="3">Todos</button>
    <button id="qs">Quick-send</button>
    <button id="tg">theme</button>
    <span data-theme-label>Light</span>
    <span class="stat loopstat" role="button" tabindex="0" aria-expanded="false" aria-controls="loop-panel">Loop</span>
    <button class="nav" data-viewbtn="4">Settings</button>
  </aside>
  <aside class="loop-panel" id="loop-panel"><button data-loop-close>x</button></aside>
  <main class="main">
    <div data-viewpane="1" class="on">term</div>
    <div data-viewpane="2">artifacts</div>
    <div data-viewpane="3">todos</div>
    <div data-viewpane="4">settings</div>
  </main>
  <aside class="drawer">
    <button id="tab-todo" class="dtab" role="tab" aria-selected="false" aria-controls="panel-todo">Todo</button>
    <button id="tab-capture" class="dtab" role="tab" aria-selected="true" aria-controls="panel-capture">Capture</button>
    <button id="dclose">x</button>
    <section id="panel-capture" class="panel" role="tabpanel">capture</section>
    <section id="panel-todo" class="panel" role="tabpanel" hidden>todo</section>
  </aside>
</div>`;

const flush = () => new Promise((r) => setTimeout(r, 0));
const pane = (v: string) => document.querySelector(`[data-viewpane="${v}"]`)!;
const navBtn = (v: string) => document.querySelector(`[data-viewbtn="${v}"]`)!;
function key(k: string, meta = true): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: meta, bubbles: true, cancelable: true }));
}

describe('shell controller (§24.1C — views, hotkeys, docked drawer, theme)', () => {
  let app: HTMLElement;
  let shell: Shell;

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = SHELL_HTML;
    app = document.getElementById('app')!;
  });

  afterEach(() => {
    shell?.dispose();
  });

  describe('view switching', () => {
    beforeEach(() => {
      shell = createShell(app);
    });

    it('marks only the selected pane and its nav button active', () => {
      shell.setView('2');
      expect(pane('2').classList.contains('on')).toBe(true);
      expect(pane('1').classList.contains('on')).toBe(false);
      expect(pane('3').classList.contains('on')).toBe(false);
      expect(navBtn('2').classList.contains('on')).toBe(true);
      expect(navBtn('1').classList.contains('on')).toBe(false);
      expect(shell.getView()).toBe('2');
    });

    it('syncs the active-view DOM contract on mount (aria-current on the inferred nav button)', () => {
      // The active view is inferred from the markup `.on`, but aria-current is only applied by
      // setView — so init must call it once, or assistive tech sees no current page until a switch.
      expect(navBtn('1').getAttribute('aria-current')).toBe('page');
      expect(navBtn('2').getAttribute('aria-current')).toBeNull();
    });

    it('switches view on a nav-button click', () => {
      (navBtn('3') as HTMLElement).click();
      expect(pane('3').classList.contains('on')).toBe(true);
      expect(shell.getView()).toBe('3');
    });

    it('switches view on Cmd+1/2/3', () => {
      key('2');
      expect(shell.getView()).toBe('2');
    });

    it('switches view on Ctrl+1/2/3 under the PC profile (§7.7)', () => {
      shell.dispose();
      shell = createShell(app, { getKeymap: () => resolveKeymap('pc') });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, cancelable: true }));
      expect(shell.getView()).toBe('3');
    });

    it('ignores a bare number key with no modifier', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      expect(shell.getView()).toBe('1');
    });

    it('opens the Settings view (4) from the rail gear and from the openSettings chord (§7.7)', () => {
      (navBtn('4') as HTMLElement).click();
      expect(shell.getView()).toBe('4');
      expect(pane('4').classList.contains('on')).toBe(true);
      expect(pane('1').classList.contains('on')).toBe(false);

      shell.setView('1');
      key(','); // ⌘, (mac default) → openSettings → view 4
      expect(shell.getView()).toBe('4');
    });

    it('opens Settings on Ctrl+, under the PC profile (§7.7)', () => {
      shell.dispose();
      shell = createShell(app, { getKeymap: () => resolveKeymap('pc') });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, cancelable: true }));
      expect(shell.getView()).toBe('4');
    });
  });

  // The shell must not reach into a sibling view's internals to focus it (§22.4); instead it
  // announces the now-active view on the decoupled bus and each view organism focuses its own
  // primary control. So the shell's observable focus contract is the FOCUS_VIEW_EVENT it emits.
  describe('focus routing on view switch (§22.4)', () => {
    let seen: string[];
    let onFocusView: (e: Event) => void;
    beforeEach(() => {
      shell = createShell(app);
      seen = [];
      onFocusView = (e) => seen.push((e as CustomEvent<{ view: string }>).detail.view);
      window.addEventListener(FOCUS_VIEW_EVENT, onFocusView);
    });
    afterEach(() => window.removeEventListener(FOCUS_VIEW_EVENT, onFocusView));

    it('announces the destination view so it can take focus, on setView', () => {
      shell.setView('2');
      expect(seen).toEqual(['2']);
    });

    it('announces the destination on Cmd/Ctrl+number (keyboard switch)', () => {
      key('3');
      expect(seen).toEqual(['3']);
    });

    it('announces the destination on a nav-button click', () => {
      (navBtn('2') as HTMLElement).click();
      expect(seen).toEqual(['2']);
    });

    // A Send (todo/capture/artifact) injects without submitting and asks for terminal focus so
    // the user can finish there (§16.2). From another view that focus would land on a hidden
    // xterm, so the shell first reveals the terminal view; the terminal then focuses via F1.
    it('reveals and activates the terminal view when a Send requests terminal focus', () => {
      shell.setView('2');
      seen.length = 0;
      window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_EVENT));
      expect(shell.getView()).toBe('1');
      expect(pane('1').classList.contains('on')).toBe(true);
      expect(seen).toContain('1'); // and it announces view 1 so the terminal organism focuses
    });
  });

  describe('docked drawer', () => {
    beforeEach(() => {
      shell = createShell(app);
    });

    it('starts open from the markup and reports it', () => {
      expect(shell.isDrawerOpen()).toBe(true);
    });

    it('toggles the dock column open and closed without a scrim', () => {
      shell.toggleDrawer();
      expect(app.classList.contains('drawer-open')).toBe(false);
      expect(shell.isDrawerOpen()).toBe(false);
      shell.toggleDrawer();
      expect(app.classList.contains('drawer-open')).toBe(true);
      // no scrim/backdrop element is ever inserted — the terminal stays visible
      expect(document.querySelector('.scrim, .backdrop')).toBeNull();
    });

    it('toggles on Cmd+K under the mac profile', () => {
      key('k');
      expect(shell.isDrawerOpen()).toBe(false);
      key('K');
      expect(shell.isDrawerOpen()).toBe(true);
    });

    it('under the PC profile uses Ctrl+Shift+K and leaves bare Ctrl+K for readline kill-line (§7.7)', () => {
      shell.dispose();
      shell = createShell(app, { getKeymap: () => resolveKeymap('pc') }); // starts open from markup
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true, bubbles: true }));
      expect(shell.isDrawerOpen()).toBe(true); // bare Ctrl+K is NOT the drawer — unchanged
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true }));
      expect(shell.isDrawerOpen()).toBe(false); // Ctrl+Shift+K toggled it
    });

    it('marks the drawer hidden when closed so its controls leave the tab order (§22.2)', () => {
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer.hidden).toBe(false); // open from markup
      shell.closeDrawer();
      expect(drawer.hidden).toBe(true);
      shell.openDrawer();
      expect(drawer.hidden).toBe(false);
    });

    it('inits the drawer hidden when the markup starts closed (§22.2)', () => {
      document.body.innerHTML = SHELL_HTML.replace('app drawer-open', 'app');
      const a = document.getElementById('app')!;
      shell = createShell(a);
      expect(shell.isDrawerOpen()).toBe(false);
      expect((a.querySelector('.drawer') as HTMLElement).hidden).toBe(true);
    });

    it('opens via the quick-send button and closes via the close button', () => {
      shell.closeDrawer();
      (document.getElementById('qs') as HTMLElement).click();
      expect(shell.isDrawerOpen()).toBe(true);
      (document.getElementById('dclose') as HTMLElement).click();
      expect(shell.isDrawerOpen()).toBe(false);
    });

    // Drawer-tab selection is NOT a shell responsibility — the action-window coordinator
    // (monitor.ts, §16.1) owns it via the real role="tab"/aria-selected contract and is
    // covered in monitorPane.test.ts. The shell only docks/undocks the drawer column.

    it('broadcasts a window resize when the dock width changes, so panes refit (§7.1)', () => {
      const onResize = vi.fn();
      window.addEventListener('resize', onResize);
      shell.closeDrawer();
      shell.openDrawer();
      window.removeEventListener('resize', onResize);
      expect(onResize).toHaveBeenCalledTimes(2);
    });
  });

  // §24.2.3 T2 — the full-height docked loop+gate panel "makes room" via a grid column exactly like
  // the drawer (no scrim). The rail's Loop read-out (#loopstat) opens it; its close button and Escape
  // dismiss it. The shell only docks/undocks the column — the panel's content is a sibling organism.
  describe('docked loop panel', () => {
    beforeEach(() => {
      shell = createShell(app);
    });

    it('starts closed and hidden, leaving its controls out of the tab order (§22.2)', () => {
      expect(shell.isLoopPanelOpen()).toBe(false);
      expect((document.getElementById('loop-panel') as HTMLElement).hidden).toBe(true);
    });

    it('toggles the dock column open/closed without a scrim, marking the read-out expanded', () => {
      const loopstat = document.querySelector('.loopstat') as HTMLElement;
      shell.toggleLoopPanel();
      expect(app.classList.contains('loop-open')).toBe(true);
      expect(shell.isLoopPanelOpen()).toBe(true);
      expect((document.getElementById('loop-panel') as HTMLElement).hidden).toBe(false);
      expect(loopstat.getAttribute('aria-expanded')).toBe('true');
      expect(document.querySelector('.scrim, .backdrop')).toBeNull();
      shell.toggleLoopPanel();
      expect(shell.isLoopPanelOpen()).toBe(false);
      expect(loopstat.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens by clicking the rail Loop read-out and closes via the panel close button', () => {
      (document.querySelector('.loopstat') as HTMLElement).click();
      expect(shell.isLoopPanelOpen()).toBe(true);
      (document.querySelector('[data-loop-close]') as HTMLElement).click();
      expect(shell.isLoopPanelOpen()).toBe(false);
    });

    it('activates the role=button Loop read-out by keyboard (Enter and Space), WCAG 2.1.1', () => {
      const loopstat = document.querySelector('.loopstat') as HTMLElement;
      const press = (key: string) =>
        loopstat.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      press('Enter');
      expect(shell.isLoopPanelOpen()).toBe(true);
      press(' ');
      expect(shell.isLoopPanelOpen()).toBe(false);
    });

    it('closes on Escape when open', () => {
      shell.openLoopPanel();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(shell.isLoopPanelOpen()).toBe(false);
    });

    it('defers Escape to an open dialog instead of closing the panel behind it (WCAG 2.4.3)', () => {
      shell.openLoopPanel();
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const inp = document.createElement('input');
      dialog.appendChild(inp);
      document.body.appendChild(dialog);
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(shell.isLoopPanelOpen()).toBe(true); // the modal owns Escape; the panel stays open
    });

    it('broadcasts a window resize when the panel width changes, so panes refit (§7.1)', () => {
      const onResize = vi.fn();
      window.addEventListener('resize', onResize);
      shell.openLoopPanel();
      shell.closeLoopPanel();
      window.removeEventListener('resize', onResize);
      expect(onResize).toHaveBeenCalledTimes(2);
    });
  });

  describe('theme', () => {
    it('applies the theme to the document element, updates the label, and persists', () => {
      const setTheme = vi.fn();
      shell = createShell(app, { setTheme });
      shell.setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.querySelector('[data-theme-label]')!.textContent).toBe('Dark');
      expect(setTheme).toHaveBeenCalledWith('dark');
    });

    it('toggles theme on the theme button', () => {
      const setTheme = vi.fn();
      shell = createShell(app, { setTheme });
      shell.setTheme('light');
      (document.getElementById('tg') as HTMLElement).click();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      (document.getElementById('tg') as HTMLElement).click();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('reads the persisted theme at startup', async () => {
      shell = createShell(app, { getTheme: () => Promise.resolve('dark') });
      await flush();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(shell.getTheme()).toBe('dark');
    });

    it('a user theme toggle before the persisted getTheme resolves is not overwritten', async () => {
      let resolveTheme: (t: 'light' | 'dark') => void = () => {};
      shell = createShell(app, { getTheme: () => new Promise((res) => (resolveTheme = res)) });
      shell.setTheme('dark'); // user toggles before the persisted value arrives
      resolveTheme('light'); // late persisted value must NOT clobber the user's choice
      await flush();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(shell.getTheme()).toBe('dark');
    });

    it('a rejected getTheme() is handled (no unhandled rejection) and keeps the default theme', async () => {
      // A failing IPC / main-process restart must not become an unhandled rejection in the
      // renderer; vitest fails the run on one, so this passes only if the catch is present.
      shell = createShell(app, { getTheme: () => Promise.reject(new Error('ipc down')) });
      await flush();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(shell.getTheme()).toBe('light');
    });
  });

  describe('viewer full screen (§20.2)', () => {
    it('toggles the app-chrome class and signals the change through the contract', () => {
      const onChange = vi.fn();
      shell = createShell(app, { onViewerFullscreenChange: onChange });
      shell.setViewerFullscreen(true);
      expect(app.classList.contains('viewer-fullscreen')).toBe(true);
      expect(shell.isViewerFullscreen()).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(true);
      shell.setViewerFullscreen(false);
      expect(app.classList.contains('viewer-fullscreen')).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith(false);
    });

    it('Escape exits full screen (and is inert otherwise)', () => {
      const onChange = vi.fn();
      shell = createShell(app, { onViewerFullscreenChange: onChange });
      key('Escape', false); // not in full screen → nothing to do
      expect(onChange).not.toHaveBeenCalled();
      shell.setViewerFullscreen(true);
      key('Escape', false);
      expect(app.classList.contains('viewer-fullscreen')).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith(false);
    });

    it('switching to another view exits full screen', () => {
      const onChange = vi.fn();
      shell = createShell(app, { onViewerFullscreenChange: onChange });
      shell.setView('2');
      shell.setViewerFullscreen(true);
      shell.setView('1');
      expect(app.classList.contains('viewer-fullscreen')).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith(false);
    });
  });

  describe('dispose', () => {
    it('removes global key listeners so hotkeys stop firing', () => {
      shell = createShell(app);
      shell.dispose();
      key('2');
      expect(shell.getView()).toBe('1');
    });
  });

  // UI-STANDARDS §3.3: the shell must read and write through root.ownerDocument, never the ambient
  // global `document`. The shell controls pre-existing markup rather than creating much DOM, so the
  // childElementCount recipe (assertRendersFromHostDocument) does not fit; instead mount it on a root
  // that lives in a FOREIGN document with the global createElement(NS) starved, drive its public
  // interface, and assert (a) it does not reach the global document (no throw) and (b) its theme
  // attribute lands on the FOREIGN documentElement — never the global one.
  it('operates through root.ownerDocument, not the global document (UI-STANDARDS §3.3)', () => {
    const foreign = document.implementation.createHTMLDocument();
    foreign.body.innerHTML = SHELL_HTML;
    const foreignApp = foreign.getElementById('app')!;
    const reach = (api: string) => () => {
      throw new Error(`shell reached for the global document.${api} instead of root.ownerDocument`);
    };
    const ce = vi.spyOn(document, 'createElement').mockImplementation(reach('createElement'));
    const cens = vi.spyOn(document, 'createElementNS').mockImplementation(reach('createElementNS'));
    try {
      shell = createShell(foreignApp);
      // Drive the public interface: view switch, drawer + loop toggles, and a theme toggle.
      shell.setView('2');
      shell.toggleDrawer();
      shell.toggleLoopPanel();
      shell.setTheme('dark');
      // Discriminating: the theme attribute landed on the FOREIGN documentElement, and the global
      // one was left untouched (a reach to the global `document` would have hit it instead).
      expect(foreign.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(foreignApp.classList.contains('drawer-open')).toBe(false);
      expect(foreignApp.classList.contains('loop-open')).toBe(true);
      expect((foreignApp.querySelector('[data-viewpane="2"]') as HTMLElement).classList.contains('on')).toBe(true);
    } finally {
      ce.mockRestore();
      cens.mockRestore();
    }
  });
});
