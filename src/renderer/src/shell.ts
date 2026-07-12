// The converged three-view shell frame (§22 / §24.1C): the app frame organism (UI-STANDARDS §1.3) —
// touches only its host subtree plus the document element it themes, takes theme persistence as an
// injected seam, and signals siblings only through the contract. The drawer docks as a layout column
// (no scrim) so the terminal stays visible beside the capture pane for cross-highlight (§16.8, amends
// §22.2 per v2.29).

import type { Theme } from '../../shared/ipc';
import { setShown } from './visibility';
import { announceViewFocus, FOCUS_TERMINAL_EVENT } from './paneActions';
import { matchChord, MAC_DEFAULTS, type Keymap } from '../../shared/keymap';

export type ViewId = '1' | '2' | '3' | '4'; // 4 = the Settings view (§7.7), reached via the gear / ⌘,

export interface Shell {
  setView(v: ViewId): void;
  getView(): ViewId;
  /** Land focus on a view's nav button, so the root needn't reach into the shell's markup (WCAG 2.4.3). */
  focusView(v: ViewId): void;
  openDrawer(): void;
  closeDrawer(): void;
  toggleDrawer(): void;
  isDrawerOpen(): boolean;
  /** The full-height docked loop+gate panel (§24.2.3): a grid column that "makes room" like the
   *  drawer, opened from the rail Loop read-out and dismissed by its close button or Escape. */
  /** `opener` is the control focus returns to when the panel closes, or omitted to leave focus where it
   *  is (the rail toggle). Moving focus into the panel is the panel's own `focusDecision`, not the shell's. */
  openLoopPanel(opener?: HTMLElement): void;
  closeLoopPanel(): void;
  toggleLoopPanel(): void;
  isLoopPanelOpen(): boolean;
  /** Re-sync the rail read-out's aria-expanded to the docked state, so the root needn't reach into the
   *  shell's `.loopstat` markup after the strip re-renders a fresh (collapsed-by-default) read-out. */
  syncLoopReadout(): void;
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
  /** The active keymap (§7.7), read live so the app-nav chords follow the user's profile/overrides.
   *  Defaults to the macOS profile when unset (the app always injects the resolved one). */
  getKeymap?: () => Keymap;
}

export function createShell(root: HTMLElement, deps: ShellDeps = {}): Shell {
  const doc = root.ownerDocument;
  const getKeymap = deps.getKeymap ?? ((): Keymap => MAC_DEFAULTS);
  const themeTarget = doc.documentElement;

  let view: ViewId = (root.querySelector('[data-viewpane].on')?.getAttribute('data-viewpane') as ViewId) ?? '1';
  let theme: Theme = themeTarget.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  let fullscreen = root.classList.contains('viewer-fullscreen');

  function setView(v: ViewId): void {
    if (fullscreen && v !== '2') setViewerFullscreen(false); // leaving the viewer restores hidden chrome (§20.2)
    view = v;
    root.querySelectorAll('[data-viewpane]').forEach((p) => p.classList.toggle('on', p.getAttribute('data-viewpane') === v));
    root.querySelectorAll('[data-viewbtn]').forEach((b) => {
      const on = b.getAttribute('data-viewbtn') === v;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // §22.4: the shell never focuses a sibling's controls — it announces, the organism focuses.
    announceViewFocus(v);
  }

  // Drawer-tab selection is owned by monitor.ts (§16.1); the shell only docks/undocks the column
  // and never touches the tabs inside it.

  // Docking changes the main pane's width without a window resize; broadcast one so width-sensitive
  // panes (the terminal's FitAddon, §7.1) refit.
  const signalLayoutChange = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };

  // Closed drawer is display:none (setShown), not a 0-width column: otherwise its tabs/buttons stay
  // in the tab order while invisible (§22.2).
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

  // Same display:none-when-closed contract as the drawer (§22.2); its .loopstat read-out carries
  // aria-expanded for assistive tech (§24.2.3).
  const loopPanelEl = root.querySelector<HTMLElement>('.loop-panel');
  const isLoopPanelOpen = (): boolean => root.classList.contains('loop-open');
  const syncLoopReadout = (on: boolean): void =>
    root.querySelector('.loopstat')?.setAttribute('aria-expanded', String(on));
  const focusView = (v: ViewId): void => void root.querySelector<HTMLElement>(`[data-viewbtn="${v}"]`)?.focus();
  // The control that opened the panel, so a close returns focus to it rather than to whichever control
  // the shell assumes opened it — the status bar's alert opens it too (WCAG 2.4.3). Moving focus INTO the
  // panel is the panel's own job (it owns the gate markup); the shell only docks the column.
  let panelOpener: HTMLElement | null = null;
  function openLoopPanel(opener?: HTMLElement): void {
    panelOpener = opener ?? null;
    root.classList.add('loop-open');
    if (loopPanelEl) setShown(loopPanelEl, true);
    syncLoopReadout(true);
    signalLayoutChange();
  }
  function closeLoopPanel(): void {
    const hadFocus = loopPanelEl?.contains(root.ownerDocument.activeElement) ?? false;
    root.classList.remove('loop-open');
    if (loopPanelEl) setShown(loopPanelEl, false);
    syncLoopReadout(false);
    // Disclosure pattern (WCAG 2.4.3): a close returns focus to whatever opened it; when that is gone
    // too (a state-driven close after the flow ends) fall back to the read-out, then the main view, so
    // focus is never stranded on the now-hidden panel.
    if (hadFocus) {
      const back = panelOpener?.isConnected ? panelOpener : root.querySelector<HTMLElement>('.loopstat');
      if (back) back.focus();
      else focusView('1');
    }
    panelOpener = null;
    signalLayoutChange();
  }
  function toggleLoopPanel(): void {
    if (isLoopPanelOpen()) closeLoopPanel();
    else openLoopPanel();
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
    if (target.closest('.loopstat')) return toggleLoopPanel();
    if (target.closest('[data-loop-close]')) return closeLoopPanel();
    if (target.closest('#tg')) return setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  // Capture phase + stopPropagation: xterm would otherwise swallow ⌘/Ctrl+K and ⌘/Ctrl+1-3 before
  // they reach the shell, so these chords must be intercepted ahead of any focused descendant (§22.4).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && fullscreen) {
      e.preventDefault();
      e.stopPropagation();
      setViewerFullscreen(false);
      return;
    }
    if (e.key === 'Escape' && isLoopPanelOpen()) {
      // Defer to an open dialog (e.g. the typed-input modal): Escape should dismiss the topmost
      // surface, not the panel behind it (WCAG 2.4.3). The modal's own handler closes it.
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      closeLoopPanel();
      return;
    }
    // The rail Loop read-out is a role=button span (§24.2.3); make it operable by keyboard like a
    // native button — Enter/Space toggle the panel (WCAG 2.1.1). Space is prevented to avoid scroll.
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element | null)?.closest?.('.loopstat')) {
      e.preventDefault();
      e.stopPropagation();
      toggleLoopPanel();
      return;
    }
    // App-nav chords come from the shared keymap (§7.7) so they follow the profile and are rebindable
    // — and so the PC default keeps bare Ctrl+K free for the terminal (readline kill-line) by binding
    // the drawer to Ctrl+Shift+K instead. Only the four app actions are claimed here; everything else
    // (terminal chords, plain keys) propagates to the focused descendant.
    const action = matchChord(e, getKeymap());
    const targetView: ViewId | null =
      action === 'viewTerminal' ? '1'
      : action === 'viewArtifacts' ? '2'
      : action === 'viewTodos' ? '3'
      : action === 'openSettings' ? '4'
      : null;
    if (action === 'toggleDrawer') {
      e.preventDefault();
      e.stopPropagation();
      toggleDrawer();
    } else if (targetView) {
      e.preventDefault();
      e.stopPropagation();
      setView(targetView);
    }
  };

  // A Send asks for terminal focus on the decoupled bus (§16.2); from another view that would hit a
  // hidden xterm, so the shell reveals the terminal view and setView announces it to focus (§22.4).
  const onFocusTerminal = (): void => setView('1');
  const win = doc.defaultView;
  win?.addEventListener(FOCUS_TERMINAL_EVENT, onFocusTerminal);

  root.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown, true);

  applyTheme(theme);
  setView(view);
  if (drawerEl) setShown(drawerEl, isDrawerOpen());
  if (loopPanelEl) setShown(loopPanelEl, isLoopPanelOpen());
  if (deps.getTheme)
    void deps
      .getTheme()
      .then((t) => { if (!themeUserSet) applyTheme(t); }) // a user toggle that already ran wins (§16.6)
      .catch(() => {}); // a rejected invoke (main restart) keeps the default theme, never rejects

  return {
    setView,
    getView: () => view,
    focusView,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    isDrawerOpen,
    openLoopPanel,
    closeLoopPanel,
    toggleLoopPanel,
    isLoopPanelOpen,
    syncLoopReadout: () => syncLoopReadout(isLoopPanelOpen()),
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
