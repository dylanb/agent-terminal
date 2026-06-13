// Resizable splitter between the terminal pane and the action window (§16.6).
// Owns only layout — the split ratio (terminal's width fraction) and the
// `role="separator"` a11y contract. The persisted ratio is a global UI pref;
// this module reads/writes it through the injected settings seam, never touching
// terminal/monitor internals.

import { DEFAULT_UI_SETTINGS, type UiSettings } from '../../shared/ipc';

export const DEFAULT_SPLIT_RATIO = DEFAULT_UI_SETTINGS.splitRatio;
export const MIN_TERMINAL_PX = 320;
export const MIN_MONITOR_PX = 280;
export const ARROW_STEP_RATIO = 0.02;

export interface LayoutSettings {
  getSettings(): Promise<UiSettings>;
  setSettings(settings: Partial<UiSettings>): void;
}

/** Wire the splitter; returns a disposer that drops the window-level drag listeners. */
export function wireLayout(settings: LayoutSettings): () => void {
  const app = document.getElementById('app');
  const terminalPane = document.getElementById('terminal-pane');
  const splitter = document.getElementById('splitter');
  if (!app || !terminalPane || !splitter) return () => {};

  let ratio = DEFAULT_SPLIT_RATIO;
  let dragging = false;

  // Min widths expressed as ratio bounds for the *current* container width.
  const bounds = (): { min: number; max: number } => {
    const width = app.getBoundingClientRect().width || 0;
    if (width <= 0) return { min: 0, max: 1 };
    return { min: MIN_TERMINAL_PX / width, max: 1 - MIN_MONITOR_PX / width };
  };

  const apply = (next: number): void => {
    const { min, max } = bounds();
    ratio = Math.min(max, Math.max(min, next));
    const pct = ratio * 100;
    terminalPane.style.flexGrow = '0';
    terminalPane.style.flexShrink = '0';
    terminalPane.style.flexBasis = `${pct}%`;
    splitter.setAttribute('aria-valuenow', String(Math.round(pct)));
    splitter.setAttribute('aria-valuemin', String(Math.round(min * 100)));
    splitter.setAttribute('aria-valuemax', String(Math.round(max * 100)));
  };

  const persist = (): void => settings.setSettings({ splitRatio: ratio });

  const onPointerDown = (e: Event): void => {
    e.preventDefault();
    dragging = true;
    const pe = e as PointerEvent;
    if (typeof pe.pointerId === 'number' && splitter.setPointerCapture) {
      splitter.setPointerCapture(pe.pointerId);
    }
  };
  const onPointerMove = (e: Event): void => {
    if (!dragging) return;
    const rect = app.getBoundingClientRect();
    const width = rect.width || 0;
    if (width <= 0) return;
    apply(((e as MouseEvent).clientX - rect.left) / width);
  };
  const onPointerUp = (): void => {
    if (!dragging) return;
    dragging = false;
    persist();
  };
  const onDblClick = (): void => {
    apply(DEFAULT_SPLIT_RATIO);
    persist();
  };
  const onKeyDown = (e: Event): void => {
    const key = (e as KeyboardEvent).key;
    if (key === 'ArrowLeft') apply(ratio - ARROW_STEP_RATIO);
    else if (key === 'ArrowRight') apply(ratio + ARROW_STEP_RATIO);
    else return;
    e.preventDefault();
    persist();
  };
  const onResize = (): void => apply(ratio); // re-clamp against the new container width

  splitter.addEventListener('pointerdown', onPointerDown);
  splitter.addEventListener('dblclick', onDblClick);
  splitter.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  void settings.getSettings().then((s) => apply(s.splitRatio));

  return () => {
    splitter.removeEventListener('pointerdown', onPointerDown);
    splitter.removeEventListener('dblclick', onDblClick);
    splitter.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('resize', onResize);
  };
}
