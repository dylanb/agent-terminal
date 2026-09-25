// §18.7.4 / §18.7.6

import type { ActiveFlowWriteResult, FlowCatalogListing, FlowCatalogListResult, FlowCatalogSelection } from '../../shared/ipc';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../../shared/controlChars';
import { isSelectionLocked } from '../../shared/flowStarted';
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

const sameRows = (a: FlowCatalogListing, b: FlowCatalogListing): boolean =>
  JSON.stringify({ ...a, selection: undefined }) === JSON.stringify({ ...b, selection: undefined });

const UNSET: FlowCatalogSelection = { kind: 'unset' };

const sameSelection = (a: FlowCatalogSelection, b: FlowCatalogSelection): boolean => JSON.stringify(a) === JSON.stringify(b);

const LOCK_REASON = 'Locked until you Terminate the run';

const reasonOf = (e: unknown, prefix: string): string =>
  displaySafeEcho(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, MAX_ECHOED_REASON_LENGTH);

let instances = 0;

export function createFlowPicker(host: HTMLElement, deps: FlowPickerDeps): FlowPicker {
  const doc = host.ownerDocument;
  const uid = `flow-picker-${++instances}`;
  let repoKey: string | null = null;
  let catalog: Catalog = { kind: 'loading' };
  let selected: FlowCatalogSelection = UNSET;
  let confirmed: FlowCatalogSelection = UNSET;
  let alertText = '';
  let open = false;
  let locked = false;
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
            sameSelection(selected, result.listing.selection) &&
            sameRows(catalog.listing, result.listing);
          catalog = { kind: 'listed', listing: result.listing };
          selected = result.listing.selection;
          confirmed = selected;
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
    selected = UNSET;
    confirmed = UNSET;
    alertText = '';
    open = false;
    render();
  }

  function onView(...[key, view]: FlowViewArgs): void {
    if (disposed) return;
    if (key === null) {
      ++generation;
      locked = false;
      switchTo(null);
      return;
    }
    const nowLocked = isSelectionLocked(view.runStarted);
    const lockChanged = nowLocked !== locked;
    locked = nowLocked;
    if (locked) open = false;
    if (key !== repoKey) switchTo(key);
    else if (lockChanged) render();
    pull(key);
  }

  function retry(): void {
    if (repoKey === null) return;
    catalog = { kind: 'loading' };
    render();
    pull(repoKey);
  }

  const canPick = (): boolean => repoKey !== null && catalog.kind === 'listed' && !locked;

  function write(next: FlowCatalogSelection, save: (key: string) => Promise<ActiveFlowWriteResult>): void {
    const key = repoKey;
    if (key === null || !canPick()) return;
    const token = ++pickGeneration;
    ++generation;
    selected = next;
    alertText = '';
    open = false;
    render();
    trigger()?.focus();
    const revert = (reason: string): void => {
      if (disposed || repoKey !== key || token !== pickGeneration) return;
      selected = confirmed;
      alertText = reason;
      render();
    };
    save(key).then(
      (result) => {
        if (result.ok) {
          if (!disposed && repoKey === key) confirmed = next;
        } else revert(result.reason);
      },
      (e: unknown) => revert(reasonOf(e, 'Could not save the selection')),
    );
  }

  const pick = (id: string): void => write({ kind: 'value', id }, (key) => deps.select(key, id));
  const useDefault = (): void => write(UNSET, (key) => deps.clearSelection(key));

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
    li.setAttribute('aria-selected', String(selected.kind === 'value' && id === selected.id));
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
    if (selected.kind === 'invalid') return 'Flow: selection unusable';
    return `Flow: ${selected.kind === 'value' ? selected.id : 'default'}`;
  }

  function triggerButton(describedByAlert: boolean): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'flow-picker-trigger pill';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', String(open));
    const describedBy = [...(describedByAlert ? [alert.id] : []), ...(locked ? [`${uid}-lock`] : [])];
    if (describedBy.length > 0) button.setAttribute('aria-describedby', describedBy.join(' '));
    button.textContent = triggerLabel();
    button.disabled = locked;
    if (catalog.kind !== 'listed') button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => {
      if (!canPick()) return;
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
    again.disabled = locked;
    again.addEventListener('click', retry);
    return again;
  }

  function lockReason(): HTMLElement {
    const reason = doc.createElement('p');
    reason.id = `${uid}-lock`;
    reason.className = 'flow-picker-lock';
    reason.tabIndex = -1;
    reason.textContent = LOCK_REASON;
    return reason;
  }

  function useDefaultButton(): HTMLButtonElement {
    const clear = doc.createElement('button');
    clear.type = 'button';
    clear.className = 'flow-picker-clear pill';
    clear.textContent = 'Use the default (clear selection)';
    clear.addEventListener('click', useDefault);
    return clear;
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
    const focusedKey =
      doc.activeElement instanceof HTMLElement && host.contains(doc.activeElement) ? doc.activeElement.dataset.flowKey : undefined;
    const restoreFocus = captureSubtreeFocus(host);
    rendering = true;
    try {
      for (const child of [...host.children]) if (child !== alert) child.remove();
      const shown = catalog.kind === 'failed' ? catalog.reason : alertText;
      if (alert.textContent !== shown) alert.textContent = shown;
      if (repoKey === null) return;

      const button = triggerButton(shown !== '');
      host.insertBefore(button, alert);
      if (locked) host.insertBefore(lockReason(), alert);
      if (catalog.kind === 'failed') host.insertBefore(retryButton(), alert);
      if (open && catalog.kind === 'listed') {
        const list = listbox(catalog.listing);
        button.setAttribute('aria-controls', list.id);
        host.insertBefore(list, alert);
        host.insertBefore(useDefaultButton(), alert);
      }
    } finally {
      rendering = false;
    }
    restoreFocus(
      () =>
        (focusedKey === undefined ? null : optionFor(focusedKey)) ??
        (locked ? host.querySelector<HTMLElement>('.flow-picker-lock') : null) ??
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
