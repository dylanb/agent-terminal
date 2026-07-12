// The always-visible status bar (§22.3.1) — a relocatable organism (UI-STANDARDS §1.3).
//
// WCAG 4.1.3 / WAI-ARIA Alert: both live regions are mounted for the bar's whole life. §22.2: an empty
// region exposes no focusable descendant.

import type { GithubRef, GithubRefKind } from '../../shared/ipc';
import { IDLE_STATUS_BAR, normalizeTitle, sameTitle, TITLE_MAX, type StatusBarModel, type StatusBarTitle } from '../../shared/statusBar';
import { stripStatusControlChars } from '../../shared/loopStatus';
import { sameOccurrence, type Occurrence } from '../../shared/occurrence';
import { createSpinner } from './spinner';

export interface StatusBarDeps {
  /** Resolve a ref's title/url within `repoKey`. Null when it cannot be resolved (no `gh`, offline,
   *  private) — the bar then keeps showing the number. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): void;
  /** Name `repoKey`'s work, or clear the name with a blank (§22.3.1). */
  setTitle(repoKey: string, text: string): Promise<void>;
  /** The human is blocked and asked for the gate controls (§24.2.3 T4). */
  onAlertActivate(): void;
  /** A name the user typed could not be saved. */
  onError(reason: string): void;
  /** The region the alert routes to, for `aria-controls` (WCAG 4.1.2). */
  loopPanelId: string;
}

export interface StatusBar {
  render(model: StatusBarModel, repoKey: string | null): void;
  dispose(): void;
}

/** A ref resolved for one repo must never land on another repo's identically-numbered ref. */
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
  let disposed = false;
  let repoKey: string | null = null;
  let latestTitle: StatusBarTitle = IDLE_STATUS_BAR.title;
  let editing = false;

  const canEdit = (title: StatusBarTitle): boolean => title.kind === 'user' && repoKey !== null;

  /** Swap the name for an input, in place. Enter commits, Escape abandons, blur commits. `forRepo` is
   *  captured here, not read at commit: the cwd moves while the editor is open, and the name belongs to
   *  the repo it was typed for (CLAUDE.md — a receiver never re-derives its target from ambient state). */
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

    let closed = false; // Enter removes the input, which fires blur — the second close must be inert
    const close = (commit: boolean): void => {
      if (closed) return;
      closed = true;
      editing = false;
      // dispose() detaches the focused input, which fires blur — and blur commits. A teardown must not
      // write a name the user never finished typing.
      if (disposed) return;
      const typed = input.value;
      const hadFocus = doc.activeElement === input;
      if (commit && typed !== from) {
        const optimistic: StatusBarTitle = { kind: 'user', text: normalizeTitle(typed) ?? '' };
        latestTitle = optimistic;
        void deps.setTitle(forRepo, typed).catch((e: unknown) => {
          deps.onError(e instanceof Error ? e.message : String(e));
          // Take the name back: the user would otherwise believe the work was named and find it gone at
          // the next relaunch. Only if the bar is still showing OUR name — a later edit or push wins.
          if (disposed || !sameTitle(latestTitle, optimistic)) return;
          latestTitle = { kind: 'user', text: from };
          shownTitle = null;
          if (!editing) renderTitle(latestTitle);
        });
      }
      shownTitle = null; // the editor replaced the name node: repaint rather than dedup against it
      renderTitle(latestTitle);
      // WCAG 2.4.3: removing the focused input would otherwise drop focus onto <body>.
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
    name.textContent = named ? title.text : 'Untitled — name this work';
    if (name instanceof HTMLButtonElement) {
      const forRepo = repoKey!; // canEdit
      name.addEventListener('click', () => beginEdit(title.text, forRepo));
    }
    titleSlot.replaceChildren(name);
  }

  function renderRef(title: StatusBarTitle & { kind: 'pr' | 'ticket' }, forRepo: string | null): void {
    // A ref whose url never resolves stays a span: a control that swallows every click advertises an
    // action it can never perform (WCAG 4.1.2).
    const label = doc.createElement('span');
    label.className = 'sb-name';
    label.dataset.sbTitle = '';
    label.textContent = title.kind === 'pr' ? `PR #${title.number}` : `#${title.number}`;
    titleSlot.replaceChildren(label);
    if (forRepo === null) return;

    const kind: GithubRefKind = title.kind === 'pr' ? 'pr' : 'issue';
    const asked: ShownRef = { repoKey: forRepo, title };
    void deps.githubRef(forRepo, kind, title.number).then((got) => {
      // The cwd/flow may have moved while `gh` ran. The guard carries the REPO as well as the ref: the
      // same number in another repo is another ref, and answering for it would paint one repo's title
      // into another's bar and arm the click with its url.
      if (disposed || got === null || !sameShownRef(asked)) return;
      refUrl = got.url;
      const link = doc.createElement('button');
      link.className = 'sb-name sb-link';
      link.dataset.sbTitle = '';
      link.setAttribute('role', 'link'); // it navigates; it does not act (WAI-ARIA APG)
      link.textContent = got.title;
      link.addEventListener('click', () => {
        if (refUrl !== null) deps.openExternal(refUrl);
      });
      titleSlot.replaceChildren(link);
    });
  }

  const sameShownRef = (asked: ShownRef): boolean => asked.repoKey === repoKey && sameTitle(asked.title, shownTitle);

  function renderTitle(title: StatusBarTitle): void {
    const editable = canEdit(title);
    // The repo is part of what is painted, not just the text: repo B's `PR #7` is not repo A's, and the
    // same unnamed title is inert before a repo is known and editable after. A dedup on the text alone
    // would keep showing A's fetched title (and open A's url) after a cd to B.
    if (sameTitle(title, shownTitle) && repoKey === shownRepo && editable === shownEditable) return;
    shownTitle = title;
    shownRepo = repoKey;
    shownEditable = editable;
    refUrl = null;

    if (title.kind === 'user') renderName(title, editable);
    else renderRef(title, repoKey);
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
      shownAlert = null;
      alert.replaceChildren();
      return;
    }
    const occ: Occurrence = { repoKey: key, status: model.alert.status, iteration: model.alert.iteration };
    if (sameOccurrence(shownAlert, occ)) return; // rebuilding would re-announce identical text
    shownAlert = occ;

    // CWE-117 — `status` comes from an arbitrary repo's state.yaml (§16.3).
    const status = stripStatusControlChars(model.alert.status);
    const { iteration, pr } = model.alert;

    const open = doc.createElement('button');
    open.className = 'sb-alert-btn';
    open.dataset.statusAlert = '';
    open.setAttribute('aria-controls', deps.loopPanelId);
    // The visible string is terse; the accessible name says what is being asked, in words assistive tech
    // can read out (WCAG 2.4.6 — `iter` expands to nothing).
    open.setAttribute(
      'aria-label',
      `Loop needs you: ${status}, iteration ${iteration}${pr !== null ? `, pull request ${pr}` : ''}`,
    );
    open.addEventListener('click', () => deps.onAlertActivate());

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

  // The bar stands up in its idle state rather than blank: it exists before any repo is known, and until
  // one is, no flow pull will ever hand it a model.
  renderTitle(IDLE_STATUS_BAR.title);

  return {
    render(model, key) {
      repoKey = key;
      latestTitle = model.title;
      // A push (a todo mutated, the agent went quiet) must not replace the field mid-word.
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
