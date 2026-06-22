// Cross-highlight (§16.8): a finding and its terminal source line share a data-find id; the pair is
// lit only via `reveal(id, on)`, the contract seam between the terminal and capture organisms
// (UI-STANDARDS §2.2) — neither pokes the other's DOM.
//
// GAP: wiring is a one-time scan of the `data-find` spans present at call time; spans added later are
// NOT picked up. Fine today (no organism emits `data-find` yet — the call site mounts the static
// mock); when real provenance spans arrive dynamically this must move to event delegation or per-pane
// re-wiring, or those spans are dropped.

export interface CrossHighlight {
  /** Light (or clear) both ends of a finding/source pair by its data-find id. */
  reveal(id: string, on: boolean): void;
  dispose(): void;
}

export function wireCrossHighlight(host: HTMLElement): CrossHighlight {
  function reveal(id: string, on: boolean): void {
    // Escape " and \ for the quoted attribute selector, else a selector-significant id makes
    // querySelector throw. Inline, not CSS.escape, so it holds under jsdom too.
    const find = id.replace(/["\\]/g, '\\$&');
    host.querySelector(`.term .src[data-find="${find}"]`)?.classList.toggle('lit', on);
    host.querySelector(`.finding[data-find="${find}"]`)?.classList.toggle('revealing', on);
  }

  const cleanups: Array<() => void> = [];
  const link = (el: Element): void => {
    const id = el.getAttribute('data-find');
    if (!id) return;
    const on = (): void => reveal(id, true);
    const off = (): void => reveal(id, false);
    el.addEventListener('mouseenter', on);
    el.addEventListener('mouseleave', off);
    cleanups.push(() => {
      el.removeEventListener('mouseenter', on);
      el.removeEventListener('mouseleave', off);
    });
  };

  host.querySelectorAll('.term .src[data-find], .finding[data-find]').forEach(link);

  return {
    reveal,
    dispose() {
      cleanups.forEach((c) => c());
      cleanups.length = 0;
    },
  };
}
