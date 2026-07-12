// The always-visible status bar (§22.3) — a relocatable organism (UI-STANDARDS §1.3) rendering
// design/shell/loop-flow.html's `.attn-bar` in its attention state. MUST be mounted in the
// always-visible main region: a hidden strip must never be able to suppress it.
//
// Two live regions, never removed from the DOM: the alert is assertive (the human is the blocker), the
// activity polite (a phrase change must not interrupt what is being read) — WCAG 4.1.3 / WAI-ARIA Alert.
// The title is not live: it is a name, not news.

import type { GithubRef, GithubRefKind } from '../../shared/ipc';
import { IDLE_STATUS_BAR, type StatusBarModel, type StatusBarTitle } from '../../shared/statusBar';
import { sameOccurrence, type Occurrence } from '../../shared/occurrence';
import { createSpinner } from './spinner';

export interface StatusBarDeps {
  /** Resolve a ref's title/url, repo-scoped by the caller at call time (the cwd moves between renders).
   *  Null when it cannot be resolved (no `gh`, offline, private) — the bar then keeps showing the number. */
  githubRef(kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): void;
  /** Name the repo's work, or clear the name with a blank (§22.3). Repo-scoped by the caller at call time. */
  setTitle(text: string): Promise<void>;
}

export interface StatusBar {
  render(model: StatusBarModel, repoKey: string | null): void;
  dispose(): void;
}

/** Titles that name the same thing. A repaint is skipped when they do — which is what stops an unchanged
 *  push from re-shelling-out to `gh`, from re-announcing, and (once the title is editable) from replacing
 *  the input the user is typing into. */
function sameTitle(a: StatusBarTitle | null, b: StatusBarTitle | null): boolean {
  if (a === null || b === null || a.kind !== b.kind) return false;
  if (a.kind === 'user') return a.text === (b as { text: string }).text;
  if (a.kind === 'unavailable') return true;
  return a.number === (b as { number: number }).number;
}

export function createStatusBar(host: HTMLElement, deps: StatusBarDeps): StatusBar {
  const doc = host.ownerDocument; // host's document, not global — relocation (UI §2.2.1)

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

  // The title now showing (or resolving), so an unchanged push repaints nothing and a superseded `gh`
  // fetch cannot land on the title the bar has since moved to.
  let shownTitle: StatusBarTitle | null = null;
  let shownEditable = false;
  let refUrl: string | null = null;
  let shownPhrase: string | null = null;
  let shownAlert: Occurrence | null = null;
  let disposed = false;
  // The repo the bar is showing, so a name commits against the repo it was typed for.
  let repoKey: string | null = null;
  // The newest model title, tracked even while the editor is open, so closing the editor repaints from
  // what the flow actually says now rather than from a snapshot taken when the edit began.
  let latestTitle: StatusBarTitle = IDLE_STATUS_BAR.title;
  let editing = false;

  /** A name can be typed only where it can be persisted: a user title, in a known repo. */
  const canEdit = (title: StatusBarTitle): boolean => title.kind === 'user' && repoKey !== null;

  /** Swap the name for an input, in place. Enter commits, Escape abandons, blur commits (clicking away
   *  must not silently discard what was typed). */
  function beginEdit(from: string): void {
    if (editing) return;
    editing = true;

    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'sb-name sb-edit';
    input.dataset.sbTitleEdit = '';
    input.value = from;
    input.setAttribute('aria-label', 'Name this work');

    let closed = false; // Enter removes the input, which fires blur — the second close must be inert
    const close = (commit: boolean): void => {
      if (closed) return;
      closed = true;
      editing = false;
      const typed = input.value;
      if (commit && typed !== from) {
        // Show it immediately and let main's push confirm it. `trim()` mirrors what the machine persists,
        // so the optimistic paint cannot disagree with the state that lands a moment later.
        const optimistic: StatusBarTitle = { kind: 'user', text: typed.trim() };
        latestTitle = optimistic;
        void deps.setTitle(typed).catch(() => {
          // The write was rejected. Take the name back rather than leave one showing that was never saved:
          // the user would believe the work was named, and find it gone at the next relaunch. Only if the
          // bar is still showing OUR optimistic name — a later edit or push has already superseded it.
          if (disposed || !sameTitle(latestTitle, optimistic)) return;
          latestTitle = { kind: 'user', text: from };
          shownTitle = null;
          if (!editing) renderTitle(latestTitle);
        });
      }
      shownTitle = null; // the editor replaced the name node: force a repaint rather than dedup against it
      renderTitle(latestTitle);
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

  function renderTitle(title: StatusBarTitle): void {
    const editable = canEdit(title);
    // Editability is part of what is painted, not just the text: the same unnamed title is inert before a
    // repo is known and editable after, so a dedup on the text alone would strand it as inert forever.
    if (sameTitle(title, shownTitle) && editable === shownEditable) return;
    shownTitle = title;
    shownEditable = editable;
    refUrl = null;

    // A `user` title with no text, and an `unavailable` one, both render the same muted placeholder — the
    // bar always has a name slot. They differ only in what may be done with it, which is why they are
    // distinct kinds: a flow that failed to load cannot persist a name, so it is never offered as editable.
    if (title.kind === 'unavailable' || title.kind === 'user') {
      const text = title.kind === 'user' ? title.text : '';
      const named = text.length > 0;
      const name = doc.createElement(editable ? 'button' : 'span');
      name.className = named ? 'sb-name' : 'sb-name empty';
      name.dataset.sbTitle = '';
      name.textContent = named ? text : editable ? 'Untitled — click to name' : 'Untitled';
      if (name instanceof HTMLButtonElement) {
        name.title = 'Rename';
        name.addEventListener('click', () => beginEdit(text));
      }
      titleSlot.replaceChildren(name);
      return;
    }

    const kind: GithubRefKind = title.kind === 'pr' ? 'pr' : 'issue';
    const link = doc.createElement('button');
    link.className = 'sb-name sb-link';
    link.dataset.sbTitle = '';
    link.textContent = title.kind === 'pr' ? `PR #${title.number}` : `#${title.number}`;
    link.addEventListener('click', () => {
      if (refUrl !== null) deps.openExternal(refUrl);
    });
    titleSlot.replaceChildren(link);

    void deps.githubRef(kind, title.number).then((got) => {
      // The cwd/flow may have moved on while `gh` ran; a superseded fetch must not repaint the bar.
      if (disposed || got === null || !sameTitle(title, shownTitle)) return;
      refUrl = got.url;
      link.textContent = got.title;
      link.title = 'Open on GitHub';
    });
  }

  function renderActivity(phrase: string | null): void {
    if (phrase === shownPhrase) return; // an unchanged phrase must not re-announce on every push (WCAG 4.1.3)
    shownPhrase = phrase;
    if (phrase === null) {
      activity.replaceChildren();
      return;
    }
    // Patch the phrase, keeping the region (and its spinner) attached: a teardown would re-announce the
    // whole region, and would restart the spinner's animation mid-turn.
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
      alert.replaceChildren(); // empty ⟺ no focusable descendant: no hidden-but-focusable trap (§22.2)
      return;
    }
    const occ: Occurrence = { repoKey: key, status: model.alert.status, iteration: model.alert.iteration };
    if (sameOccurrence(shownAlert, occ)) return; // rebuilding would re-announce identical text
    shownAlert = occ;

    // The alert IS the control: its text is the button's accessible name, so the assertive announcement
    // and the route to the gate controls are one node rather than two competing ones.
    const open = doc.createElement('button');
    open.className = 'sb-alert-btn';
    open.dataset.statusAlert = ''; // the shell opens the docked loop panel from this

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const lead = doc.createElement('b');
    lead.textContent = 'Loop needs you';
    const detail = doc.createElement('span');
    detail.className = 'it';
    const pr = model.alert.pr !== null ? ` · PR #${model.alert.pr}` : '';
    detail.textContent = `${model.alert.status} · iter ${model.alert.iteration}${pr}`;

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
      // A push (a todo mutated, the agent went quiet) must not replace the field mid-word: while the editor
      // is open the title repaints when the edit closes, from `latestTitle`, not from under the user.
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
