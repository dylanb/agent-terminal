// The converged three-view shell frame (§22 / §24.1C): view switching, app-global
// hotkeys (⌘/Ctrl+1/2/3, ⌘/Ctrl+K), the docked non-blurring quick-send drawer, and
// the light/dark theme. It is the app frame organism (UI-STANDARDS §1.3): it touches
// only its host subtree and the document element it themes, takes theme persistence
// as an injected seam, and signals nothing to sibling organisms directly. The drawer
// docks as a layout column — it never inserts a scrim — so the terminal stays visible
// beside the capture pane for cross-highlight (§16.8, amends §22.2 per v2.29).

import type { Theme } from '../../shared/ipc';

export type ViewId = '1' | '2' | '3';
export type DrawerTab = 'todo' | 'capture';

const VIEWS: readonly ViewId[] = ['1', '2', '3'];

export interface Shell {
  setView(v: ViewId): void;
  getView(): ViewId;
  openDrawer(tab?: DrawerTab): void;
  closeDrawer(): void;
  toggleDrawer(tab?: DrawerTab): void;
  isDrawerOpen(): boolean;
  selectTab(tab: DrawerTab): void;
  getTab(): DrawerTab;
  setTheme(t: Theme): void;
  getTheme(): Theme;
  dispose(): void;
}

/** Theme persistence seam (§16.6) — injected, never reached for (UI-STANDARDS §2.2). */
export interface ShellDeps {
  getTheme?: () => Promise<Theme>;
  setTheme?: (t: Theme) => void;
}

export function createShell(root: HTMLElement, deps: ShellDeps = {}): Shell {
  const doc = root.ownerDocument;
  const themeTarget = doc.documentElement;

  let view: ViewId = (root.querySelector('[data-viewpane].on')?.getAttribute('data-viewpane') as ViewId) ?? '1';
  let tab: DrawerTab = (root.querySelector('.drawer .tab.on')?.getAttribute('data-tab') as DrawerTab) ?? 'capture';
  let theme: Theme = themeTarget.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  function setView(v: ViewId): void {
    view = v;
    root.querySelectorAll('[data-viewpane]').forEach((p) => p.classList.toggle('on', p.getAttribute('data-viewpane') === v));
    root.querySelectorAll('[data-viewbtn]').forEach((b) => {
      const on = b.getAttribute('data-viewbtn') === v;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  function selectTab(t: DrawerTab): void {
    tab = t;
    root.querySelectorAll('.drawer .tab').forEach((el) => el.classList.toggle('on', el.getAttribute('data-tab') === t));
    root.querySelectorAll('[data-tabpanel]').forEach((el) => {
      (el as HTMLElement).hidden = el.getAttribute('data-tabpanel') !== t;
    });
  }

  // The dock is a layout column, so opening/closing it changes the main pane's width
  // without a window resize. Broadcast one so width-sensitive panes (the terminal's
  // FitAddon, §7.1) refit — the same decoupled signal the old splitter used.
  const signalLayoutChange = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };

  const isDrawerOpen = (): boolean => root.classList.contains('drawer-open');
  function openDrawer(t?: DrawerTab): void {
    root.classList.add('drawer-open');
    if (t) selectTab(t);
    signalLayoutChange();
  }
  function closeDrawer(): void {
    root.classList.remove('drawer-open');
    signalLayoutChange();
  }
  function toggleDrawer(t?: DrawerTab): void {
    if (isDrawerOpen()) closeDrawer();
    else openDrawer(t);
  }

  function applyTheme(t: Theme): void {
    theme = t;
    themeTarget.setAttribute('data-theme', t);
    root.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = t === 'dark' ? 'Dark' : 'Light';
    });
  }
  function setTheme(t: Theme): void {
    applyTheme(t);
    deps.setTheme?.(t);
  }

  const onClick = (e: Event): void => {
    const target = e.target as Element;
    const vb = target.closest('[data-viewbtn]');
    if (vb && root.contains(vb)) return setView(vb.getAttribute('data-viewbtn') as ViewId);
    const dt = target.closest('.drawer .tab');
    if (dt && root.contains(dt)) return selectTab(dt.getAttribute('data-tab') as DrawerTab);
    if (target.closest('#qs')) return toggleDrawer();
    if (target.closest('#dclose')) return closeDrawer();
    if (target.closest('#tg')) return setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  // Capture phase + stopPropagation: the terminal (xterm) would otherwise swallow
  // ⌘/Ctrl+K (a control char) and ⌘/Ctrl+1-3 before they reach us, so the shell's
  // own chords must be intercepted ahead of any focused descendant (§22.4).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'k') {
      e.preventDefault();
      e.stopPropagation();
      toggleDrawer();
    } else if ((VIEWS as readonly string[]).includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      setView(e.key as ViewId);
    }
  };

  root.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown, true);

  applyTheme(theme);
  if (deps.getTheme) void deps.getTheme().then(applyTheme);

  return {
    setView,
    getView: () => view,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    isDrawerOpen,
    selectTab,
    getTab: () => tab,
    setTheme,
    getTheme: () => theme,
    dispose() {
      root.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
