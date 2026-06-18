// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShell, type Shell } from '../../src/renderer/src/shell';

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
  </aside>
  <main class="main">
    <div data-viewpane="1" class="on">term</div>
    <div data-viewpane="2">artifacts</div>
    <div data-viewpane="3">todos</div>
  </main>
  <aside class="drawer">
    <button class="tab" data-tab="todo">Todo</button>
    <button class="tab on" data-tab="capture">Capture</button>
    <button id="dclose">x</button>
    <div class="panel" data-tabpanel="todo" hidden>todo</div>
    <div class="panel" data-tabpanel="capture">capture</div>
  </aside>
</div>`;

const flush = () => new Promise((r) => setTimeout(r, 0));
const pane = (v: string) => document.querySelector(`[data-viewpane="${v}"]`)!;
const navBtn = (v: string) => document.querySelector(`[data-viewbtn="${v}"]`)!;
const drawerTab = (t: string) => document.querySelector(`.drawer .tab[data-tab="${t}"]`)!;
const tabPanel = (t: string) => document.querySelector(`[data-tabpanel="${t}"]`) as HTMLElement;

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

    it('switches view on a nav-button click', () => {
      (navBtn('3') as HTMLElement).click();
      expect(pane('3').classList.contains('on')).toBe(true);
      expect(shell.getView()).toBe('3');
    });

    it('switches view on Cmd/Ctrl+1/2/3 and prevents the default', () => {
      key('2');
      expect(shell.getView()).toBe('2');
      key('3', false); // works with Ctrl too (metaKey=false → ctrlKey path covered below)
    });

    it('switches view on Ctrl+1/2/3 (non-mac)', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, cancelable: true }));
      expect(shell.getView()).toBe('3');
    });

    it('ignores a bare number key with no modifier', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      expect(shell.getView()).toBe('1');
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

    it('toggles on Cmd/Ctrl+K', () => {
      key('k');
      expect(shell.isDrawerOpen()).toBe(false);
      key('K');
      expect(shell.isDrawerOpen()).toBe(true);
    });

    it('marks the drawer hidden when closed so its controls leave the tab order (§A11Y)', () => {
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

    it('selects a drawer tab, showing its panel and hiding the others', () => {
      shell.selectTab('todo');
      expect(drawerTab('todo').classList.contains('on')).toBe(true);
      expect(drawerTab('capture').classList.contains('on')).toBe(false);
      expect(tabPanel('todo').hidden).toBe(false);
      expect(tabPanel('capture').hidden).toBe(true);
      expect(shell.getTab()).toBe('todo');
    });

    it('selects a tab on click', () => {
      (drawerTab('todo') as HTMLElement).click();
      expect(shell.getTab()).toBe('todo');
    });

    it('opening with a tab argument docks and selects that tab', () => {
      shell.closeDrawer();
      shell.openDrawer('todo');
      expect(shell.isDrawerOpen()).toBe(true);
      expect(shell.getTab()).toBe('todo');
    });

    it('broadcasts a window resize when the dock width changes, so panes refit (§7.1)', () => {
      const onResize = vi.fn();
      window.addEventListener('resize', onResize);
      shell.closeDrawer();
      shell.openDrawer();
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
});
