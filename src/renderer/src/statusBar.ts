// §22.3.1; UI-STANDARDS §1.3; WCAG 4.1.3.

import type { GithubRef, GithubRefKind } from '../../shared/ipc';
import { IDLE_STATUS_BAR, normalizeTitle, sameTitle, TITLE_MAX, type StatusBarModel, type StatusBarTitle } from '../../shared/statusBar';
import { stripStatusControlChars } from '../../shared/loopStatus';
import { sameOccurrence, type Occurrence } from '../../shared/occurrence';
import { createSpinner } from './spinner';

export interface StatusBarDeps {
  /** Resolve a ref's title/url within `repoKey`. Null when it cannot be resolved (no `gh`, offline,
   *  private) — the bar then keeps showing the number. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): Promise<boolean> | void;
  /** Name `repoKey`'s work, or clear the name with a blank (§22.3.1). */
  setTitle(repoKey: string, text: string): Promise<void>;
  /** The human is blocked and sent to the panel's gate decision, recovery Retry, or stable Close entry
   *  (§24.2.3 T4). `opener` lets the panel return focus without reaching into this DOM. */
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
      const hadFocus = doc.activeElement === input;
      if (commit && typed !== from) {
        const optimistic: StatusBarTitle = { kind: 'user', text: normalizeTitle(typed) ?? '' };
        const mutation = ++titleMutation;
        const revision = renderRevision;
        if (repoKey === forRepo) latestTitle = optimistic;
        void deps.setTitle(forRepo, typed).catch((e: unknown) => {
          deps.onError(e instanceof Error ? e.message : String(e));
          if (
            disposed ||
            repoKey !== forRepo ||
            renderRevision !== revision ||
            titleMutation !== mutation ||
            !sameTitle(latestTitle, optimistic)
          ) return;
          latestTitle = { kind: 'user', text: from };
          shownTitle = null;
          if (!editing) renderTitle(latestTitle);
        });
      }
      shownTitle = null;
      renderTitle(latestTitle);
      // WCAG 2.4.3.
      if (hadFocus) titleSlot.querySelector<HTMLElement>('[data-sb-title]')?.focus();
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
    const named = title.text.length > 0;
    const name = doc.createElement(editable ? 'button' : 'span');
    name.className = named ? 'sb-name' : 'sb-name empty';
    name.dataset.sbTitle = '';
    if (!editable) name.tabIndex = -1; // WCAG 2.4.3
    name.textContent = named ? title.text : 'Untitled — name this work';
    if (name instanceof HTMLButtonElement) {
      const forRepo = repoKey!; // canEdit
      if (named) name.setAttribute('aria-label', `Rename work: ${title.text}`);
      name.addEventListener('click', () => beginEdit(title.text, forRepo));
    }
    titleSlot.replaceChildren(name);
  }

  function renderRef(title: StatusBarTitle & { kind: 'pr' | 'ticket' }, forRepo: string | null): void {
    // WCAG 4.1.2.
    const label = doc.createElement('span');
    label.className = 'sb-name';
    label.dataset.sbTitle = '';
    label.tabIndex = -1; // WCAG 2.4.3
    label.textContent = title.kind === 'pr' ? `PR #${title.number}` : `#${title.number}`;
    titleSlot.replaceChildren(label);
    if (forRepo === null) return;

    const kind: GithubRefKind = title.kind === 'pr' ? 'pr' : 'issue';
    const asked: ShownRef = { repoKey: forRepo, title };
    void deps.githubRef(forRepo, kind, title.number).then((got) => {
      // CLAUDE.md resource-identity rule.
      if (disposed || got === null || !sameShownRef(asked)) return;
      const hadFocus = titleSlot.contains(doc.activeElement);
      refUrl = got.url;
      const link = doc.createElement('button');
      link.className = 'sb-name sb-link';
      link.dataset.sbTitle = '';
      link.setAttribute('role', 'link'); // WAI-ARIA APG
      link.textContent = got.title;
      link.addEventListener('click', () => {
        if (refUrl === null) return;
        void Promise.resolve(deps.openExternal(refUrl))
          .then((opened) => {
            if (opened === false) throw new Error('the operating system refused the link');
          })
          .catch((e: unknown) => deps.onOpenError(e instanceof Error ? e.message : String(e)));
      });
      titleSlot.replaceChildren(link);
      if (hadFocus) link.focus();
    });
  }

  const sameShownRef = (asked: ShownRef): boolean => asked.repoKey === repoKey && sameTitle(asked.title, shownTitle);

  function renderTitle(title: StatusBarTitle): void {
    const editable = canEdit(title);
    if (sameTitle(title, shownTitle) && repoKey === shownRepo && editable === shownEditable) return;
    // WCAG 2.4.3.
    const hadFocus = titleSlot.contains(doc.activeElement);
    shownTitle = title;
    shownRepo = repoKey;
    shownEditable = editable;
    refUrl = null;

    if (title.kind === 'user') renderName(title, editable);
    else renderRef(title, repoKey);
    if (hadFocus) titleSlot.querySelector<HTMLElement>('[data-sb-title]')?.focus();
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
      // WCAG 2.4.3.
      const hadFocus = alert.contains(doc.activeElement);
      shownAlert = null;
      shownAlertPr = null;
      alert.replaceChildren();
      if (hadFocus) titleSlot.querySelector<HTMLElement>('[data-sb-title]')?.focus();
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
    open.addEventListener('click', () => deps.onAlertActivate(open));

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const lead = doc.createElement('b');
    lead.textContent = 'Loop needs you';
    const detail = doc.createElement('span');
    detail.className = 'it';
    detail.textContent = `${status} · iter ${iteration}${pr !== null ? ` · PR #${pr}` : ''}`;

    open.append(dot, lead, doc.createTextNode(' — '), detail);
    alert.replaceChildren(open);
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
