import { hasFlowRefs, type FlowLoopView, type FlowRefs } from '../../shared/ipc';
import type { TokenTableView } from './tokenTable';

export interface DockedPanelDeps {
  /** Repaint the docked panel from the view (no-op when no panel is mounted). */
  render(loop: FlowLoopView | null, title: string, refs?: FlowRefs, tokens?: TokenTableView): void;
  /** Hide the docked panel column, returning focus to the read-out / main view (shell.closeLoopPanel). */
  closePanel(): void;
  /** Re-sync the rail read-out's aria-expanded to the docked state (a fresh read-out defaults collapsed). */
  syncExpanded(): void;
}

/** Route a flow view's loop, refs and counts to the docked panel (§24.2.3 T2/T7). When nothing is left to show,
 *  close the panel BEFORE clearing it: the close hands focus off the still-present close control, then
 *  render() clears the now-unfocused panel — clearing first would remove the focused control and strand
 *  focus on <body> (WCAG 2.4.3). */
export function syncDockedPanel(
  loop: FlowLoopView | null,
  title: string,
  refs: FlowRefs | undefined,
  tokens: TokenTableView | undefined,
  deps: DockedPanelDeps,
): void {
  if (hasFlowRefs(refs) || loop !== null) {
    deps.render(loop, title, refs, tokens);
    deps.syncExpanded();
  } else {
    deps.closePanel();
    deps.render(loop, title, refs, tokens);
  }
}
