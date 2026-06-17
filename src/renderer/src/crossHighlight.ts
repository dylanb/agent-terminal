// Cross-highlight (§16.8): a capture finding and its terminal source line share a
// data-find id; hovering either lights both, with both on screen at once (the drawer
// docks, never covers — §22.2 amendment, v2.29). This is the contract seam between
// the terminal and capture organisms (UI-STANDARDS §2.2): neither pokes the other's
// DOM directly — both register their data-find spans with this wiring inside a shared
// host, and a `reveal(id, on)` call lights the pair from either side or a deep-link.

export interface CrossHighlight {
  /** Light (or clear) both ends of a finding/source pair by its data-find id. */
  reveal(id: string, on: boolean): void;
  dispose(): void;
}

export function wireCrossHighlight(host: HTMLElement): CrossHighlight {
  function reveal(id: string, on: boolean): void {
    host.querySelector(`.term .src[data-find="${id}"]`)?.classList.toggle('lit', on);
    host.querySelector(`.finding[data-find="${id}"]`)?.classList.toggle('revealing', on);
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
