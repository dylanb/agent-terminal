// §18.7.4 / §18.7.6

import type { ActiveFlowWriteResult, CatalogOrigin, RebindChoice, RebindResult, FlowCatalogListing, FlowCatalogListResult, FlowCatalogSelection } from '../../shared/ipc';
import { displaySafeEcho, MAX_ECHOED_LOCK_REASON_LENGTH, MAX_ECHOED_REASON_LENGTH } from '../../shared/controlChars';
import { isSelectionLocked } from '../../shared/flowStarted';
import { offersHeldRunRecovery, type HeldRunView } from '../../shared/runHold';
import { captureSubtreeFocus } from './dom';
import type { FlowViewArgs } from './flowView';

export interface FlowPickerDeps {
  /** Returns an unsubscribe. */
  onView(cb: (...args: FlowViewArgs) => void): () => void;
  listCatalog(repoKey: string): Promise<FlowCatalogListResult>;
  select(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  clearSelection(repoKey: string): Promise<ActiveFlowWriteResult>;
  rebindHeldRun(repoKey: string, choice: RebindChoice): Promise<RebindResult>;
}

export interface FlowPicker {
  refresh(): void;
  dispose(): void;
}

type CatalogEntry = FlowCatalogListing['entries'][number];

type Catalog =
  | { kind: 'loading' }
  | { kind: 'listed'; listing: FlowCatalogListing }
  | { kind: 'failed'; reason: string };

const sameRows = (a: FlowCatalogListing, b: FlowCatalogListing): boolean =>
  JSON.stringify({ ...a, selection: undefined }) === JSON.stringify({ ...b, selection: undefined });

const UNSET: FlowCatalogSelection = { kind: 'unset' };

const sameSelection = (a: FlowCatalogSelection, b: FlowCatalogSelection): boolean => JSON.stringify(a) === JSON.stringify(b);

const TIER_LABEL: Record<CatalogOrigin, string> = { repo: 'Repo flows', global: 'Global flows' };

const LOCK_REASON = 'Locked until you Terminate the run';
const STUCK_RECORD_LOCK_REASON = 'Locked: the run record could not be removed. Start the run, then Terminate it, to retry.';
const EMPTY_CATALOG_TEXT = 'No catalog flows are listed.';
const EMPTY_RECOVERY_TEXT = 'No listed flow can resume this run; Terminate it to end the run.';

type HeldRun = Exclude<HeldRunView, { hold: 'not-held' }>;

const HOLD_TEXT: Record<HeldRun['hold'], string> = {
  'record-missing': 'This run cannot continue: its run record is missing.',
  'record-unreadable': 'This run cannot continue: its run record is unreadable.',
};

const STATUS_TEXT: Record<HeldRun['status'], string> = { in_progress: 'in progress', done: 'done' };

type Row =
  | { kind: 'choice'; key: string; name: string; origin: string; selected: boolean; choose: () => void }
  | { kind: 'unavailable'; key: string; name: string; origin: string; reason: string };

const heldOf = (view: { runHold?: HeldRunView }): HeldRun | null => {
  const hold = view.runHold ?? { hold: 'not-held' };
  return offersHeldRunRecovery(hold) ? hold : null;
};

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
  let noticeOutlivesRelease = false;
  let open = false;
  let locked = false;
  let held: HeldRun | null = null;
  let resetWithRecord = false;
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
    noticeOutlivesRelease = false;
    open = false;
    render();
  }

  function onView(...[key, view]: FlowViewArgs): void {
    if (disposed) return;
    if (key === null) {
      ++generation;
      locked = false;
      held = null;
      resetWithRecord = false;
      switchTo(null);
      return;
    }
    const nowLocked = isSelectionLocked(view.runStarted);
    const nowHeld = heldOf(view);
    const nowResetWithRecord = nowLocked && view.status === 'not_started';
    const changed =
      nowLocked !== locked || nowResetWithRecord !== resetWithRecord || JSON.stringify(nowHeld) !== JSON.stringify(held);
    resetWithRecord = nowResetWithRecord;
    const gateFlipped = nowLocked !== locked || (nowHeld === null) !== (held === null);
    const released = held !== null && nowHeld === null;
    if (gateFlipped && !(released && noticeOutlivesRelease)) alertText = '';
    if (released) noticeOutlivesRelease = false;
    locked = nowLocked;
    held = nowHeld;
    if (changed) open = false;
    if (key !== repoKey) switchTo(key);
    else if (changed) render();
    pull(key);
  }

  function retry(): void {
    if (repoKey === null) return;
    catalog = { kind: 'loading' };
    render();
    pull(repoKey);
  }

  const canPick = (): boolean => repoKey !== null && catalog.kind === 'listed' && !locked;
  const canRecover = (): boolean => repoKey !== null && catalog.kind === 'listed' && held !== null;

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

  function rebind(choice: RebindChoice): void {
    const key = repoKey;
    if (key === null || !canRecover()) return;
    const token = ++pickGeneration;
    alertText = '';
    open = false;
    render();
    recoverButton()?.focus();
    const announce = (reason: string): void => {
      if (disposed || repoKey !== key || token !== pickGeneration) return;
      alertText = displaySafeEcho(reason, MAX_ECHOED_LOCK_REASON_LENGTH);
      render();
    };
    deps.rebindHeldRun(key, choice).then(
      (result) => {
        if (!result.ok) announce(result.reason);
        else if (result.outcome === 'terminated' && result.notice !== undefined) {
          noticeOutlivesRelease = held !== null;
          announce(result.notice);
        }
      },
      (e: unknown) => announce(reasonOf(e, 'Could not recover the run')),
    );
  }

  const trigger = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.flow-picker-trigger');
  const recoverButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.flow-picker-recover');
  const allOptions = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  const optionFor = (flowKey: string): HTMLElement | undefined => allOptions().find((o) => o.dataset.flowKey === flowKey);

  function collapse(): void {
    open = false;
    render();
  }

  function close(): void {
    if (!open) return;
    collapse();
    (recoverButton() ?? trigger())?.focus();
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

  function option(row: Row, index: number): HTMLElement {
    const li = doc.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `${uid}-opt-${index}`;
    li.className = 'flow-picker-option';
    li.tabIndex = -1;
    li.dataset.flowKey = row.key;
    const name = doc.createElement('span');
    name.id = `${uid}-name-${index}`;
    name.className = 'flow-picker-name';
    name.textContent = row.name;
    const origin = doc.createElement('span');
    origin.id = `${uid}-origin-${index}`;
    origin.className = 'flow-picker-origin';
    origin.textContent = row.origin;
    li.append(name, origin);
    li.setAttribute('aria-labelledby', `${name.id} ${origin.id}`);
    if (row.kind === 'unavailable') {
      li.setAttribute('aria-disabled', 'true');
      const reason = doc.createElement('span');
      reason.id = `${uid}-reason-${index}`;
      reason.className = 'flow-picker-reason';
      reason.textContent = row.reason;
      li.setAttribute('aria-describedby', reason.id);
      li.append(reason);
      return li;
    }
    const { choose } = row;
    li.setAttribute('aria-selected', String(row.selected));
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });
    return li;
  }

  const isUnavailable = (entry: CatalogEntry): entry is Extract<CatalogEntry, { available: false }> => !entry.available;

  const unavailableRow = (entry: Extract<CatalogEntry, { available: false }>): Row => ({
    kind: 'unavailable',
    key: entry.label,
    name: entry.label,
    origin: entry.origin,
    reason: entry.reason,
  });

  function selectRows(listing: FlowCatalogListing): Row[] {
    return listing.entries.map((entry): Row => {
      if (!entry.available) return unavailableRow(entry);
      const { id } = entry;
      return {
        kind: 'choice',
        key: id,
        name: id,
        origin: entry.origin,
        selected: selected.kind === 'value' && id === selected.id,
        choose: () => pick(id),
      };
    });
  }

  function recoveryRows(listing: FlowCatalogListing): Row[] {
    const choice = (key: string, name: string, origin: string, to: RebindChoice): Row => ({
      kind: 'choice',
      key,
      name,
      origin,
      selected: false,
      choose: () => rebind(to),
    });
    return [
      ...(listing.hasLocalFlow ? [choice('local:', 'flow.yaml', 'local (this worktree)', { origin: 'local' })] : []),
      ...listing.entries.filter(isUnavailable).map(unavailableRow),
      ...listing.resumable.map(({ origin, id }) => choice(`${origin}:${id}`, id, origin, { origin, id })),
      ...(listing.hasGlobalFallback ? [choice('fallback:', 'Global fallback flow', 'fallback', { origin: 'fallback' })] : []),
    ];
  }

  function triggerLabel(): string {
    if (catalog.kind === 'loading') return 'Flow: loading…';
    if (catalog.kind === 'failed') return 'Flow: unavailable';
    if (selected.kind === 'invalid') return 'Flow: selection unusable';
    return `Flow: ${selected.kind === 'value' ? selected.id : 'default'}`;
  }

  function triggerButton(describedByAlert: boolean, noticeIds: string[]): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'flow-picker-trigger pill';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', String(open));
    const describedBy = [...(describedByAlert ? [alert.id] : []), ...(locked ? [`${uid}-lock`] : []), ...noticeIds];
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
    again.disabled = locked && held === null;
    again.addEventListener('click', retry);
    return again;
  }

  function lockReason(): HTMLElement {
    const reason = doc.createElement('p');
    reason.id = `${uid}-lock`;
    reason.className = 'flow-picker-lock';
    reason.tabIndex = -1;
    reason.textContent = resetWithRecord ? STUCK_RECORD_LOCK_REASON : LOCK_REASON;
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

  function listbox(rows: Row[], label: string): HTMLUListElement {
    const list = doc.createElement('ul');
    list.id = `${uid}-list`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    list.className = 'flow-picker-list';
    list.append(...rows.map(option));
    return list;
  }

  function emptyNote(): HTMLElement {
    const p = doc.createElement('p');
    p.id = `${uid}-empty`;
    p.className = 'flow-picker-empty';
    p.textContent = held === null ? EMPTY_CATALOG_TEXT : EMPTY_RECOVERY_TEXT;
    return p;
  }

  function recoverControl(describedByAlert: boolean, extraIds: string[]): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'flow-picker-recover pill';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-describedby', [`${uid}-held`, ...(describedByAlert ? [alert.id] : []), ...extraIds].join(' '));
    button.textContent = 'Recover the run onto a flow…';
    if (catalog.kind !== 'listed') button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => {
      if (!canRecover()) return;
      open = !open;
      render();
      if (open) host.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')?.focus();
    });
    return button;
  }

  function heldSummary(run: HeldRun): HTMLElement {
    const p = doc.createElement('p');
    p.id = `${uid}-held`;
    p.className = 'flow-picker-held';
    p.textContent = `${HOLD_TEXT[run.hold]} Choosing a flow resumes step ${run.step} (${STATUS_TEXT[run.status]}).`;
    return p;
  }

  function tierNotices(listing: FlowCatalogListing): HTMLElement[] {
    return listing.tierNotices.map(({ origin, notice }, index) => {
      const p = doc.createElement('p');
      p.id = `${uid}-notice-${index}`;
      p.className = 'flow-picker-notice';
      p.textContent = `${TIER_LABEL[origin]}: ${notice}`;
      return p;
    });
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

      const listing = open && catalog.kind === 'listed' ? catalog.listing : null;
      const notices = listing === null ? [] : tierNotices(listing);
      const rows = listing === null ? null : held === null ? selectRows(listing) : recoveryRows(listing);
      const nothingToChoose = rows !== null && (held === null ? rows.length === 0 : !rows.some((row) => row.kind === 'choice'));
      const empty = nothingToChoose ? emptyNote() : null;
      const noticeIds = [...(empty === null ? [] : [empty.id]), ...notices.map((n) => n.id)];
      const button = triggerButton(shown !== '' && held === null, held === null ? noticeIds : []);
      host.insertBefore(button, alert);
      if (locked) host.insertBefore(lockReason(), alert);
      let recover: HTMLButtonElement | null = null;
      if (held !== null) {
        recover = recoverControl(shown !== '', noticeIds);
        host.insertBefore(heldSummary(held), alert);
        host.insertBefore(recover, alert);
      }
      if (catalog.kind === 'failed') host.insertBefore(retryButton(), alert);
      if (rows !== null) {
        if (empty !== null) host.insertBefore(empty, alert);
        if (rows.length > 0) {
          const list = listbox(rows, held === null ? 'Flows' : 'Flows to recover the run onto');
          (recover ?? button).setAttribute('aria-controls', list.id);
          if (notices.length > 0) list.setAttribute('aria-describedby', notices.map((n) => n.id).join(' '));
          host.insertBefore(list, alert);
        }
        for (const notice of notices) host.insertBefore(notice, alert);
        if (held === null) host.insertBefore(useDefaultButton(), alert);
      }
    } finally {
      rendering = false;
    }
    restoreFocus(
      () =>
        (focusedKey === undefined ? null : optionFor(focusedKey)) ??
        recoverButton() ??
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
