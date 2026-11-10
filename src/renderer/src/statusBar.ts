// §22.3.1; UI-STANDARDS §1.3; WCAG 4.1.3.

import type { GithubRef, GithubRefKind } from '../../shared/ipc';
import { IDLE_STATUS_BAR, normalizeTitle, sameTitle, statusBarTitleText, TITLE_MAX, type StatusBarModel, type StatusBarTitle } from '../../shared/statusBar';
import { stripStatusControlChars } from '../../shared/loopStatus';
import { sameOccurrence, type Occurrence } from '../../shared/occurrence';
import { createSpinner } from './spinner';
import { captureSubtreeFocus } from './dom';
import { createPressGroup, onPress } from './pressable';

export interface StatusBarDeps {
  /** Resolve a ref's title/url within `repoKey`. Null when it cannot be resolved (no `gh`, offline,
   *  private) — the bar then keeps showing the number. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): Promise<boolean> | void;
  /** Name `repoKey`'s work, or clear the name with a blank (§22.3.1). */
  setTitle(repoKey: string, text: string): Promise<void>;
  /** The human is blocked and sent to the panel's gate decision, the work-turn route out, or stable Close
   *  entry (§24.2.3 T4). `opener` lets the panel return focus without reaching into this DOM. */
  onAlertActivate(opener: HTMLElement): void;
  /** A name the user typed could not be saved. */
  onError(reason: string): void;
  /** A resolved ref could not be opened by the OS. */
  onOpenError(reason: string): void;
  /** The region the alert routes to, for `aria-controls` (WCAG 4.1.2). */
  loopPanelId: string;
}

export interface StatusBar {
  render(model: StatusBarModel, repoKey: string | null): void;
  dispose(): void;
}

interface ShownRef {
  repoKey: string;
  title: StatusBarTitle;
}

export function createStatusBar(host: HTMLElement, deps: StatusBarDeps): StatusBar {
  const doc = host.ownerDocument; // UI §2.2.1

  const titleSlot = doc.createElement('span');
  titleSlot.className = 'sb-title';

  const activity = doc.createElement('span');
  activity.className = 'sb-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');

  const alert = doc.createElement('span');
  alert.className = 'sb-alert';
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');

  host.replaceChildren(titleSlot, activity, alert);

  let shownTitle: StatusBarTitle | null = null;
  let shownRepo: string | null = null;
  let shownEditable = false;
  let refUrl: string | null = null;
  let shownPhrase: string | null = null;
  let shownAlert: Occurrence | null = null;
  let shownAlertPr: number | null = null;
  let disposed = false;
  let repoKey: string | null = null;
  let latestTitle: StatusBarTitle = IDLE_STATUS_BAR.title;
  let editing = false;
  let renderRevision = 0;
  let titleMutation = 0;

  const opening = createPressGroup();

  const canEdit = (title: StatusBarTitle): boolean => title.kind === 'user' && repoKey !== null;

  // CLAUDE.md resource-identity rule.
  function beginEdit(from: string, forRepo: string): void {
    if (editing) return;
    editing = true;

    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'sb-name sb-edit';
    input.dataset.sbTitleEdit = '';
    input.value = from;
    input.maxLength = TITLE_MAX;
    input.setAttribute('aria-label', 'Name this work');

    let closed = false;
    const close = (commit: boolean): void => {
      if (closed) return;
      closed = true;
      editing = false;
      if (disposed) return;
      const typed = input.value;
      const restore = captureSubtreeFocus(titleSlot);
      const normalized = normalizeTitle(typed) ?? '';
      if (commit && normalized !== from) {
        const optimistic: StatusBarTitle = { kind: 'user', text: normalized };
        const mutation = ++titleMutation;
        const revision = renderRevision;
        if (repoKey === forRepo) latestTitle = optimistic;
        void deps.setTitle(forRepo, typed).catch((e: unknown) => {
          const stale = disposed || repoKey !== forRepo || titleMutation !== mutation;
          if (stale) return;
          deps.onError(e instanceof Error ? e.message : String(e));
          const optimisticStillShown = renderRevision === revision && sameTitle(latestTitle, optimistic);
          if (optimisticStillShown) {
            latestTitle = { kind: 'user', text: from };
            shownTitle = null;
            if (!editing) renderTitle(latestTitle);
          }
        });
      }
      shownTitle = null;
      renderTitle(latestTitle);
      restore(() => titleSlot.querySelector<HTMLElement>('[data-sb-title]'));
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    });
    input.addEventListener('blur', () => close(true));

    titleSlot.replaceChildren(input);
    input.focus();
    input.select();
  }

  function renderName(title: StatusBarTitle & { kind: 'user' }, editable: boolean): void {
    const shown = statusBarTitleText(title, null);
    const named = shown !== null;
    const name = doc.createElement(editable ? 'button' : 'span');
    name.className = named ? 'sb-name' : 'sb-name empty';
    name.dataset.sbTitle = '';
    if (!editable) name.tabIndex = -1; // WCAG 2.4.3
    name.textContent = shown ?? 'Untitled — name this work';
    if (name instanceof HTMLButtonElement) {
      const forRepo = repoKey!; // canEdit
      if (named) name.setAttribute('aria-label', `Rename work: ${title.text}`);
      onPress(name, () => beginEdit(title.text, forRepo));
    }
    titleSlot.replaceChildren(name);
  }

  function renderRef(title: StatusBarTitle & { kind: 'pr' | 'ticket' }, forRepo: string | null): void {
    // WCAG 4.1.2.
    const label = doc.createElement('span');
    label.className = 'sb-name';
    label.dataset.sbTitle = '';
    label.tabIndex = -1; // WCAG 2.4.3
    label.textContent = statusBarTitleText(title, null);
    titleSlot.replaceChildren(label);
    if (forRepo === null) return;

    const kind: GithubRefKind = title.kind === 'pr' ? 'pr' : 'issue';
    const asked: ShownRef = { repoKey: forRepo, title };
    void deps.githubRef(forRepo, kind, title.number).then((got) => {
      // CLAUDE.md resource-identity rule.
      if (disposed || got === null || !sameShownRef(asked)) return;
      const restore = captureSubtreeFocus(titleSlot);
      refUrl = got.url;
      const link = doc.createElement('button');
      link.className = 'sb-name sb-link';
      link.dataset.sbTitle = '';
      link.setAttribute('role', 'link'); // WAI-ARIA APG
      const refTitle = statusBarTitleText(title, got.title);
      link.textContent = refTitle;
      // WCAG 2.4.4.
      link.setAttribute(
        'aria-label',
        `${title.kind === 'pr' ? 'PR' : 'Ticket'} #${title.number}: ${refTitle} (opens in browser)`,
      );
      opening.bind(link, () => {
        if (refUrl === null) return;
        const url = refUrl;
        return (async () => {
          const opened = await deps.openExternal(url);
          if (opened === false) throw new Error('the operating system refused the link');
        })().catch((e: unknown) => deps.onOpenError(e instanceof Error ? e.message : String(e)));
      });
      titleSlot.replaceChildren(link);
      restore(() => link);
    }).catch(() => {
      // Deliberate: a resolution failure is non-fatal — the bar keeps the number (see githubRef).
    });
  }

  const sameShownRef = (asked: ShownRef): boolean => asked.repoKey === repoKey && sameTitle(asked.title, shownTitle);

  function renderTitle(title: StatusBarTitle): void {
    const editable = canEdit(title);
    if (sameTitle(title, shownTitle) && repoKey === shownRepo && editable === shownEditable) return;
    const restore = captureSubtreeFocus(titleSlot);
    shownTitle = title;
    shownRepo = repoKey;
    shownEditable = editable;
    refUrl = null;

    if (title.kind === 'user') renderName(title, editable);
    else renderRef(title, repoKey);
    restore(() => titleSlot.querySelector<HTMLElement>('[data-sb-title]'));
  }

  function renderActivity(phrase: string | null): void {
    if (phrase === shownPhrase) return; // an unchanged phrase must not re-announce (WCAG 4.1.3)
    shownPhrase = phrase;
    if (phrase === null) {
      activity.replaceChildren();
      return;
    }
    const existing = activity.querySelector('.phrase');
    if (existing) {
      existing.textContent = phrase;
      return;
    }
    const text = doc.createElement('span');
    text.className = 'phrase';
    text.textContent = phrase;
    activity.replaceChildren(text, createSpinner(doc));
  }

  function renderAlert(model: StatusBarModel, key: string | null): void {
    if (model.alert === null) {
      const restore = captureSubtreeFocus(alert);
      shownAlert = null;
      shownAlertPr = null;
      alert.replaceChildren();
      restore(() => titleSlot.querySelector<HTMLElement>('[data-sb-title]'));
      return;
    }
    const occ: Occurrence = { repoKey: key, status: model.alert.status, iteration: model.alert.iteration };
    if (sameOccurrence(shownAlert, occ) && shownAlertPr === model.alert.pr) return;
    shownAlert = occ;
    shownAlertPr = model.alert.pr;

    // CWE-117 — `status` comes from an arbitrary repo's state.yaml (§16.3).
    const status = stripStatusControlChars(model.alert.status);
    const { iteration, pr } = model.alert;

    const open = doc.createElement('button');
    open.className = 'sb-alert-btn';
    open.dataset.statusAlert = '';
    open.setAttribute('aria-controls', deps.loopPanelId);
    onPress(open, () => deps.onAlertActivate(open));

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const lead = doc.createElement('b');
    lead.textContent = 'Loop needs you';
    const detail = doc.createElement('span');
    detail.className = 'it';
    const iterSeg = iteration !== undefined ? ` · iter ${iteration}` : '';
    detail.textContent = `${status}${iterSeg}${pr !== null ? ` · PR #${pr}` : ''}`;

    open.append(dot, lead, doc.createTextNode(' — '), detail);
    const restore = captureSubtreeFocus(alert);
    alert.replaceChildren(open);
    restore(() => open);
  }

  renderTitle(IDLE_STATUS_BAR.title);

  return {
    render(model, key) {
      renderRevision += 1;
      repoKey = key;
      latestTitle = model.title;
      if (!editing) renderTitle(model.title);
      renderActivity(model.activity?.phrase ?? null);
      renderAlert(model, key);
    },
    dispose() {
      disposed = true;
      host.replaceChildren();
    },
  };
}
