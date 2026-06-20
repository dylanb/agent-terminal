// The converged three-view shell frame (§22 / §24.1C): view switching, app-global
// hotkeys (⌘/Ctrl+1/2/3, ⌘/Ctrl+K), the docked non-blurring quick-send drawer, and
// the light/dark theme. It is the app frame organism (UI-STANDARDS §1.3): it touches
// only its host subtree and the document element it themes, takes theme persistence
// as an injected seam, and signals nothing to sibling organisms directly. The drawer
// docks as a layout column — it never inserts a scrim — so the terminal stays visible
// beside the capture pane for cross-highlight (§16.8, amends §22.2 per v2.29).

import type { Theme } from '../../shared/ipc';
import { setShown } from './visibility';
import { announceViewFocus, FOCUS_TERMINAL_EVENT } from './paneActions';

export type ViewId = '1' | '2' | '3';

const VIEWS: readonly ViewId[] = ['1', '2', '3'];

export interface Shell {
  setView(v: ViewId): void;
  getView(): ViewId;
  openDrawer(): void;
  closeDrawer(): void;
  toggleDrawer(): void;
  isDrawerOpen(): boolean;
  setTheme(t: Theme): void;
  getTheme(): Theme;
  /** Full-screen the viewer by hiding all app chrome (§20.2); Escape and a view change exit. */
  setViewerFullscreen(on: boolean): void;
  isViewerFullscreen(): boolean;
  dispose(): void;
}

/** Theme persistence seam (§16.6) — injected, never reached for (UI-STANDARDS §2.2). */
export interface ShellDeps {
  getTheme?: () => Promise<Theme>;
  setTheme?: (t: Theme) => void;
  /** Signalled when viewer full screen toggles (§20.2) so the viewer can collapse its chrome. */
  onViewerFullscreenChange?: (on: boolean) => void;
}

export function createShell(root: HTMLElement, deps: ShellDeps = {}): Shell {
  const doc = root.ownerDocument;
  const themeTarget = doc.documentElement;

  let view: ViewId = (root.querySelector('[data-viewpane].on')?.getAttribute('data-viewpane') as ViewId) ?? '1';
  let theme: Theme = themeTarget.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  let fullscreen = root.classList.contains('viewer-fullscreen');

  function setView(v: ViewId): void {
    if (fullscreen && v !== '2') setViewerFullscreen(false); // chrome is hidden; leaving the viewer restores it
    view = v;
    root.querySelectorAll('[data-viewpane]').forEach((p) => p.classList.toggle('on', p.getAttribute('data-viewpane') === v));
    root.querySelectorAll('[data-viewbtn]').forEach((b) => {
      const on = b.getAttribute('data-viewbtn') === v;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // The pane is now visible; hand focus to its organism so the keyboard lands in the view the
    // user just switched to (the terminal, so they can keep typing). The shell never focuses a
    // sibling's controls itself — it announces, the organism focuses (§22.4).
    announceViewFocus(v);
  }

  // Drawer-tab selection is owned by the action-window coordinator (monitor.ts, §16.1),
  // which keys off the real `role="tab"`/`aria-selected` contract and persists lastTab. The
  // shell only docks/undocks the drawer column; it never touches the tabs inside it.

  // The dock is a layout column, so opening/closing it changes the main pane's width
  // without a window resize. Broadcast one so width-sensitive panes (the terminal's
  // FitAddon, §7.1) refit — the same decoupled signal the old splitter used.
  const signalLayoutChange = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };

  // The drawer is display:none when closed (via setShown), not just a 0-width column — otherwise its
  // tabs/buttons stay in the tab order while invisible (§22.2). The grid class sizes it when open.
  const drawerEl = root.querySelector<HTMLElement>('.drawer');
  const isDrawerOpen = (): boolean => root.classList.contains('drawer-open');
  function openDrawer(): void {
    root.classList.add('drawer-open');
    if (drawerEl) setShown(drawerEl, true);
    signalLayoutChange();
  }
  function closeDrawer(): void {
    root.classList.remove('drawer-open');
    if (drawerEl) setShown(drawerEl, false);
    signalLayoutChange();
  }
  function toggleDrawer(): void {
    if (isDrawerOpen()) closeDrawer();
    else openDrawer();
  }

  function applyTheme(t: Theme): void {
    theme = t;
    themeTarget.setAttribute('data-theme', t);
    root.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = t === 'dark' ? 'Dark' : 'Light';
    });
  }
  let themeUserSet = false; // a user toggle must not be clobbered by a late persisted getTheme (§16.6)
  function setTheme(t: Theme): void {
    themeUserSet = true;
    applyTheme(t);
    deps.setTheme?.(t);
  }

  function setViewerFullscreen(on: boolean): void {
    if (on === fullscreen) return;
    fullscreen = on;
    root.classList.toggle('viewer-fullscreen', on);
    deps.onViewerFullscreenChange?.(on);
    signalLayoutChange(); // hiding/showing chrome changes the main width → refit width-sensitive panes
  }

  const onClick = (e: Event): void => {
    const target = e.target as Element;
    const vb = target.closest('[data-viewbtn]');
    if (vb && root.contains(vb)) return setView(vb.getAttribute('data-viewbtn') as ViewId);
    if (target.closest('#qs')) return toggleDrawer();
    if (target.closest('#dclose')) return closeDrawer();
    if (target.closest('#tg')) return setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  // Capture phase + stopPropagation: the terminal (xterm) would otherwise swallow
  // ⌘/Ctrl+K (a control char) and ⌘/Ctrl+1-3 before they reach us, so the shell's
  // own chords must be intercepted ahead of any focused descendant (§22.4).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && fullscreen) {
      e.preventDefault();
      e.stopPropagation();
      setViewerFullscreen(false);
      return;
    }
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

  // A Send (todo/capture/artifact) asks for terminal focus on the decoupled bus (§16.2). From
  // another view that focus would hit a hidden xterm, so the shell reveals the terminal view;
  // setView then announces it and the terminal organism focuses (§22.4). Owning the reveal here
  // keeps the focus path single — the terminal no longer listens for this event itself.
  const onFocusTerminal = (): void => setView('1');
  const win = doc.defaultView;
  win?.addEventListener(FOCUS_TERMINAL_EVENT, onFocusTerminal);

  root.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown, true);

  applyTheme(theme);
  setView(view); // sync the pane/nav classes + aria-current to the markup-inferred view on mount
  if (drawerEl) setShown(drawerEl, isDrawerOpen()); // match the drawer's inert state to its start class
  // A failing IPC / main-process restart must not become an unhandled rejection; on failure
  // keep the default theme.
  if (deps.getTheme)
    void deps
      .getTheme()
      .then((t) => { if (!themeUserSet) applyTheme(t); }) // skip if the user already chose a theme
      .catch(() => {});

  return {
    setView,
    getView: () => view,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    isDrawerOpen,
    setTheme,
    getTheme: () => theme,
    setViewerFullscreen,
    isViewerFullscreen: () => fullscreen,
    dispose() {
      root.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKeyDown, true);
      win?.removeEventListener(FOCUS_TERMINAL_EVENT, onFocusTerminal);
    },
  };
}
