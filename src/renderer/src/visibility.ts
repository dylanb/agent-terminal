// Accessible show/hide (§22.2) — the one place the app hides content, so a hidden panel never traps
// focus. Paired with the CSS enforcement in styles.css (`[hidden]{display:none!important}`,
// `.is-collapsed{visibility:hidden}`); never hide focusable content with display/opacity/width tricks
// that leave it tabbable.

/** Fully show or remove `el` (display:none when hidden). The default, non-animated show/hide. */
export function setShown(el: HTMLElement, shown: boolean): void {
  el.hidden = !shown;
}

/** Collapse/expand `el` for an animated panel: inert when collapsed (visibility:hidden) yet still
 * able to run a CSS transform transition. */
export function setCollapsed(el: HTMLElement, collapsed: boolean): void {
  el.classList.toggle('is-collapsed', collapsed);
}
