// Accessible show/hide (UI-STANDARDS §A11Y) — the one place the app hides content. Hiding always
// removes the subtree from layout, the tab order, AND the accessibility tree, so a hidden panel can
// never trap keyboard focus. Paired with the CSS enforcement in styles.css:
//   [hidden]      { display: none !important; }   // robust against any competing `display` rule
//   .is-collapsed { visibility: hidden; }          // inert, but still able to run a CSS transition
// Never hide focusable content with display/transform/opacity/width tricks that leave it tabbable.

/** Fully show or remove `el` (display:none when hidden). The default, non-animated show/hide. */
export function setShown(el: HTMLElement, shown: boolean): void {
  el.hidden = !shown;
}

/** Collapse/expand `el` for an animated panel: inert when collapsed (visibility:hidden) yet still
 * able to run a CSS transform transition. */
export function setCollapsed(el: HTMLElement, collapsed: boolean): void {
  el.classList.toggle('is-collapsed', collapsed);
}
