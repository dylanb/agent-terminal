// §18.7.4 / §18.7.6

import type { ActiveFlowWriteResult, FlowCatalogListing, FlowCatalogListResult } from '../../shared/ipc';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../../shared/controlChars';
import { captureSubtreeFocus } from './dom';
import type { FlowViewArgs } from './flowView';

export interface FlowPickerDeps {
  /** Returns an unsubscribe. */
  onView(cb: (...args: FlowViewArgs) => void): () => void;
  listCatalog(repoKey: string): Promise<FlowCatalogListResult>;
  select(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  clearSelection(repoKey: string): Promise<ActiveFlowWriteResult>;
}

export interface FlowPicker {
  refresh(): void;
  dispose(): void;
}

type CatalogEntry = FlowCatalogListing['entries'][number];

const entryKey = (entry: CatalogEntry): string => (entry.available ? entry.id : entry.label);

type Catalog =
  | { kind: 'loading' }
  | { kind: 'listed'; listing: FlowCatalogListing }
  | { kind: 'failed'; reason: string };

const reasonOf = (e: unknown, prefix: string): string =>
  displaySafeEcho(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, MAX_ECHOED_REASON_LENGTH);

let instances = 0;

export function createFlowPicker(host: HTMLElement, deps: FlowPickerDeps): FlowPicker {
  const doc = host.ownerDocument;
  const uid = `flow-picker-${++instances}`;
  let repoKey: string | null = null;
  let catalog: Catalog = { kind: 'loading' };
  let selectedId: string | undefined;
  let alertText = '';
  let open = false;
  let generation = 0;
  let pickGeneration = 0;
  let disposed = false;
  let rendering = false;

  // UI-STANDARDS §4.1/§4.2
  const alert = doc.createElement('div');
  alert.id = `${uid}-alert`;
  alert.className = 'flow-picker-alert';
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  host.append(alert);

  function pull(key: string): void {
    const gen = ++generation;
    const current = (): boolean => !disposed && gen === generation && repoKey === key;
    deps.listCatalog(key).then(
      (result) => {
        if (!current()) return;
        if (result.ok) {
          const unchanged =
            catalog.kind === 'listed' &&
            selectedId === result.listing.selectedId &&
            JSON.stringify(catalog.listing) === JSON.stringify(result.listing);
          catalog = { kind: 'listed', listing: result.listing };
          selectedId = result.listing.selectedId;
          if (unchanged) return;
        } else {
          catalog = { kind: 'failed', reason: result.reason };
          open = false;
        }
        render();
      },
      (e: unknown) => {
        if (!current()) return;
        catalog = { kind: 'failed', reason: reasonOf(e, 'Could not list flows') };
        open = false;
        render();
      },
    );
  }

  function switchTo(key: string | null): void {
    repoKey = key;
    catalog = { kind: 'loading' };
    selectedId = undefined;
    alertText = '';
    open = false;
    render();
  }

  function onView(...[key]: FlowViewArgs): void {
    if (disposed) return;
    if (key === null) {
      ++generation;
      switchTo(null);
      return;
    }
    if (key !== repoKey) switchTo(key);
    pull(key);
  }

  function retry(): void {
    if (repoKey === null) return;
    catalog = { kind: 'loading' };
    render();
    pull(repoKey);
  }

  function pick(id: string): void {
    if (repoKey === null || catalog.kind !== 'listed') return;
    const key = repoKey;
    const prior = selectedId;
    const token = ++pickGeneration;
    ++generation;
    selectedId = id;
    alertText = '';
    open = false;
    render();
    trigger()?.focus();
    const revert = (reason: string): void => {
      if (disposed || repoKey !== key || token !== pickGeneration) return;
      selectedId = prior;
      alertText = reason;
      render();
    };
    deps.select(key, id).then(
      (result) => {
        if (!result.ok) revert(result.reason);
      },
      (e: unknown) => revert(reasonOf(e, 'Could not save the selection')),
    );
  }

  const trigger = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.flow-picker-trigger');
  const allOptions = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  const optionFor = (flowKey: string): HTMLElement | undefined => allOptions().find((o) => o.dataset.flowKey === flowKey);

  function collapse(): void {
    open = false;
    render();
  }

  function close(): void {
    if (!open) return;
    collapse();
    trigger()?.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const opts = allOptions();
    if (opts.length === 0) return;
    const at = opts.indexOf(doc.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(at + 1, opts.length - 1) : Math.max(at - 1, 0);
    opts[next]?.focus();
  }

  function onOutsidePointer(e: Event): void {
    if (open && !host.contains(e.target as Node)) collapse();
  }

  function onFocusOut(e: FocusEvent): void {
    if (rendering || !open) return;
    if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return;
    collapse();
  }

  function option(entry: CatalogEntry, index: number): HTMLElement {
    const li = doc.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `${uid}-opt-${index}`;
    li.className = 'flow-picker-option';
    li.tabIndex = -1;
    li.dataset.flowKey = entryKey(entry);
    const name = doc.createElement('span');
    name.id = `${uid}-name-${index}`;
    name.className = 'flow-picker-name';
    name.textContent = entryKey(entry);
    const origin = doc.createElement('span');
    origin.id = `${uid}-origin-${index}`;
    origin.className = 'flow-picker-origin';
    origin.textContent = entry.origin;
    li.append(name, origin);
    li.setAttribute('aria-labelledby', `${name.id} ${origin.id}`);
    if (!entry.available) {
      li.setAttribute('aria-disabled', 'true');
      const reason = doc.createElement('span');
      reason.id = `${uid}-reason-${index}`;
      reason.className = 'flow-picker-reason';
      reason.textContent = entry.reason;
      li.setAttribute('aria-describedby', reason.id);
      li.append(reason);
      return li;
    }
    const id = entry.id;
    li.setAttribute('aria-selected', String(id === selectedId));
    li.addEventListener('click', () => pick(id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(id);
      }
    });
    return li;
  }

  function triggerLabel(): string {
    if (catalog.kind === 'loading') return 'Flow: loading…';
    if (catalog.kind === 'failed') return 'Flow: unavailable';
    return `Flow: ${selectedId ?? 'default'}`;
  }

  function triggerButton(describedByAlert: boolean): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'flow-picker-trigger pill';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', String(open));
    if (describedByAlert) button.setAttribute('aria-describedby', alert.id);
    button.textContent = triggerLabel();
    if (catalog.kind !== 'listed') button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => {
      if (catalog.kind !== 'listed') return;
      open = !open;
      render();
      if (open) (host.querySelector<HTMLElement>('[aria-selected="true"]') ?? allOptions()[0])?.focus();
    });
    return button;
  }

  function retryButton(): HTMLButtonElement {
    const again = doc.createElement('button');
    again.type = 'button';
    again.className = 'flow-picker-retry pill';
    again.textContent = 'Retry';
    again.setAttribute('aria-describedby', alert.id);
    again.addEventListener('click', retry);
    return again;
  }

  function listbox(listing: FlowCatalogListing): HTMLUListElement {
    const list = doc.createElement('ul');
    list.id = `${uid}-list`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Flows');
    list.className = 'flow-picker-list';
    list.append(...listing.entries.map(option));
    return list;
  }

  function render(): void {
    if (disposed) return;
    const focused = doc.activeElement instanceof HTMLElement && host.contains(doc.activeElement) ? doc.activeElement : null;
    const focusedKey = focused?.dataset.flowKey;
    const restoreFocus = captureSubtreeFocus(host);
    rendering = true;
    try {
      for (const child of [...host.children]) if (child !== alert) child.remove();
      const shown = catalog.kind === 'failed' ? catalog.reason : alertText;
      if (alert.textContent !== shown) alert.textContent = shown;
      if (repoKey === null) return;

      const button = triggerButton(shown !== '');
      host.insertBefore(button, alert);
      if (catalog.kind === 'failed') host.insertBefore(retryButton(), alert);
      if (open && catalog.kind === 'listed') {
        const list = listbox(catalog.listing);
        button.setAttribute('aria-controls', list.id);
        host.insertBefore(list, alert);
      }
    } finally {
      rendering = false;
    }
    restoreFocus(
      () =>
        (focusedKey === undefined ? null : optionFor(focusedKey)) ??
        (catalog.kind === 'failed' ? host.querySelector<HTMLElement>('.flow-picker-retry') : null) ??
        trigger(),
    );
  }

  host.addEventListener('keydown', onKeydown);
  host.addEventListener('focusout', onFocusOut);
  doc.addEventListener('mousedown', onOutsidePointer);
  const unsubscribe = deps.onView(onView);

  return {
    refresh() {
      if (!disposed && repoKey !== null) pull(repoKey);
    },
    dispose() {
      disposed = true;
      unsubscribe();
      host.removeEventListener('keydown', onKeydown);
      host.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('mousedown', onOutsidePointer);
      host.replaceChildren();
    },
  };
}
