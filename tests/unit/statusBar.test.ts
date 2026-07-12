// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStatusBar, type StatusBarDeps } from '../../src/renderer/src/statusBar';
import { assertRendersFromHostDocument } from './relocatable';
import type { StatusBarModel } from '../../src/shared/statusBar';
import type { GithubRef } from '../../src/shared/ipc';

// §22.3.1 — the always-visible status bar. It shows the work's title, what the engine is doing, and (in
// its attention state) that the loop is blocked on a human. All three coexist; the bar never collapses.

const REPO = '/repo';

const model = (over: Partial<StatusBarModel> = {}): StatusBarModel => ({
  title: { kind: 'user', text: '' },
  activity: null,
  alert: null,
  ...over,
});
const blocked = { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179 };

const ref = (over: Partial<GithubRef> = {}): GithubRef => ({
  title: 'Persist flow inputs across steps',
  body: 'b',
  url: 'https://github.com/o/r/pull/57',
  ...over,
});

function mount(deps: Partial<StatusBarDeps> = {}): {
  host: HTMLElement;
  bar: ReturnType<typeof createStatusBar>;
  render: (m: StatusBarModel, repoKey?: string | null) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = createStatusBar(host, {
    githubRef: deps.githubRef ?? (() => Promise.resolve(null)),
    openExternal: deps.openExternal ?? (() => {}),
    setTitle: deps.setTitle ?? (() => Promise.resolve()),
    onAlertActivate: deps.onAlertActivate ?? (() => {}),
    onError: deps.onError ?? (() => {}),
    loopPanelId: deps.loopPanelId ?? 'loop-panel',
  });
  return { host, bar, render: (m, repoKey = REPO) => bar.render(m, repoKey) };
}

/** Open the in-place name editor and return it. */
function edit(host: HTMLElement): HTMLInputElement {
  (titleEl(host) as HTMLButtonElement).click();
  return host.querySelector<HTMLInputElement>('[data-sb-title-edit]')!;
}
const press = (el: HTMLElement, key: string): void => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

const titleEl = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-sb-title]');
const alertEl = (host: HTMLElement): HTMLElement => host.querySelector('.sb-alert')!;
const alertBtn = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-status-alert]');
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('status bar (§22.3.1)', () => {
  describe('it is always there', () => {
    it('keeps its live regions mounted even with nothing to say, so the next alert announces', () => {
      // WAI-ARIA Alert pattern (WCAG 4.1.3): the region must already be in the a11y tree when content is
      // injected. An empty bar therefore stays mounted and un-[hidden] — it is a status surface, not a
      // cue that comes and goes.
      const { host } = mount();
      expect(host.hidden).toBe(false);
      expect(alertEl(host)).not.toBeNull();
      expect(host.querySelector('.sb-activity')).not.toBeNull();
    });

    it('exposes no focusable control inside a live region it has nothing to say in', () => {
      // empty region ⟺ no focusable descendant: the permanent bar must not re-introduce a
      // hidden-but-focusable trap (§22.2). The title slot is not a live region and is exempt.
      const { host, render } = mount();
      render(model());
      expect(alertEl(host).querySelector('button, [tabindex]')).toBeNull();
      expect(host.querySelector('.sb-activity')!.querySelector('button, [tabindex]')).toBeNull();
    });

    it('invites a name before it is handed anything at all', () => {
      // The bar exists before any repo is known — there is no flow to pull from, and no render() has run.
      // A status bar with no status is the empty state, not a blank strip.
      const { host } = mount();
      expect(titleEl(host)).not.toBeNull();
      expect(titleEl(host)!.textContent!.length).toBeGreaterThan(0);
    });
  });

  describe('the title names the work — the PR, else the ticket, else the user', () => {
    it('shows the PR number at once and upgrades it to the fetched title', async () => {
      // The number rides flow:state synchronously; `gh` is a best-effort shell-out. The user never sees
      // an empty title waiting on the network.
      const githubRef = vi.fn(() => Promise.resolve(ref()));
      const { host, render } = mount({ githubRef });
      render(model({ title: { kind: 'pr', number: 57 } }));
      expect(titleEl(host)!.textContent).toContain('PR #57');
      await flush();
      expect(titleEl(host)!.textContent).toContain('Persist flow inputs across steps');
      expect(githubRef).toHaveBeenCalledWith(REPO, 'pr', 57);
    });

    it('keeps showing the number when the fetch fails, rather than blanking the title', async () => {
      const { host, render } = mount({ githubRef: () => Promise.resolve(null) });
      render(model({ title: { kind: 'ticket', number: 42 } }));
      await flush();
      expect(titleEl(host)!.textContent).toContain('#42');
    });

    it('opens the ref on GitHub when the title is clicked', async () => {
      const openExternal = vi.fn();
      const { host, render } = mount({ githubRef: () => Promise.resolve(ref()), openExternal });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      titleEl(host)!.click();
      expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/57');
    });

    it('does not offer to open a ref whose url never resolved', async () => {
      const openExternal = vi.fn();
      const { host, render } = mount({ githubRef: () => Promise.resolve(null), openExternal });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      titleEl(host)!.click();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('shows the name the user gave when no ref supplies one', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      expect(titleEl(host)!.textContent).toContain('Refactor the shadow parser');
    });

    it('invites a name when the work is unnamed', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: '' } }));
      expect(titleEl(host)!.textContent!.length).toBeGreaterThan(0);
    });

    it('invites a name in a directory whose flow never loaded — the case where nothing else can name it', () => {
      // Every directory without a flow.yaml IS a load-error view, and has no PR or ticket either. The
      // name belongs to the worktree, not to a flow that happened to load (§22.3.1).
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: '' } }));
      expect(titleEl(host)!.tagName).toBe('BUTTON');
    });

    it('does not re-fetch an unchanged ref on every push', async () => {
      const githubRef = vi.fn(() => Promise.resolve(ref()));
      const { render } = mount({ githubRef });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      render(model({ title: { kind: 'pr', number: 57 }, activity: { phrase: 'Working' } }));
      await flush();
      expect(githubRef).toHaveBeenCalledTimes(1);
    });

    it('shows the late-arriving title of the ref it is CURRENTLY on, never a superseded one', async () => {
      // A slow fetch for the ticket must not overwrite the title after the flow moved on to its PR.
      let settleTicket: (r: GithubRef | null) => void = () => {};
      const githubRef = vi.fn((kind: string) =>
        kind === 'issue'
          ? new Promise<GithubRef | null>((res) => {
              settleTicket = res;
            })
          : Promise.resolve(ref({ title: 'The PR title' })),
      );
      const { host, render } = mount({ githubRef });
      render(model({ title: { kind: 'ticket', number: 42 } }));
      render(model({ title: { kind: 'pr', number: 57 } })); // the PR landed while the ticket was in flight
      await flush();
      settleTicket(ref({ title: 'The stale ticket title' }));
      await flush();
      expect(titleEl(host)!.textContent).toContain('The PR title');
      expect(titleEl(host)!.textContent).not.toContain('stale');
    });
  });

  describe('naming the work yourself', () => {
    const editor = (host: HTMLElement): HTMLInputElement | null => host.querySelector('input[data-sb-title-edit]');
    const startEditing = (host: HTMLElement): HTMLInputElement => {
      titleEl(host)!.click();
      return editor(host)!;
    };
    const type = (input: HTMLInputElement, text: string): void => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const press = (input: HTMLInputElement, key: string): void => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };

    it('opens an editor in place when the unnamed title is clicked', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: '' } }));
      expect(editor(host)).toBeNull();
      expect(startEditing(host)).not.toBeNull();
    });

    it('commits the typed name on Enter', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = startEditing(host);
      type(input, 'Refactor the shadow parser');
      press(input, 'Enter');
      expect(setTitle).toHaveBeenCalledWith(REPO, 'Refactor the shadow parser');
    });

    it('abandons the edit on Escape, keeping the name that was there', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      const input = startEditing(host);
      type(input, 'something else entirely');
      press(input, 'Escape');
      expect(setTitle).not.toHaveBeenCalled();
      expect(editor(host)).toBeNull();
      expect(titleEl(host)!.textContent).toContain('Refactor the shadow parser');
    });

    it('commits on blur, so clicking away does not silently discard what was typed', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = startEditing(host);
      type(input, 'Named by blur');
      input.dispatchEvent(new Event('blur'));
      expect(setTitle).toHaveBeenCalledWith(REPO, 'Named by blur');
    });

    it('does not write when the name was not actually changed', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      const input = startEditing(host);
      press(input, 'Enter'); // committed unchanged
      expect(setTitle).not.toHaveBeenCalled();
    });

    it('lets the user clear the name by emptying it', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      const input = startEditing(host);
      type(input, '');
      press(input, 'Enter');
      expect(setTitle).toHaveBeenCalledWith(REPO, '');
    });

    it('keeps the editor open while a push arrives, so a live re-pull cannot eat what is being typed', () => {
      // The bar is repainted by every flow:onStateChanged push (a todo mutated, the agent went quiet).
      // A repaint that replaced the input mid-word would make the field impossible to type in.
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = startEditing(host);
      type(input, 'half a nam');
      render(model({ title: { kind: 'user', text: '' }, activity: { phrase: 'Working' } }));
      expect(editor(host)).toBe(input);
      expect(editor(host)!.value).toBe('half a nam');
    });

    it('takes the name back when the write fails, rather than showing one that was never saved', async () => {
      // The commit paints the new name at once and lets main confirm it. If the write is rejected (main
      // restarted, a read-only tree), the bar must not go on displaying a name that does not exist — the
      // user would believe their work was named and it would be gone at the next relaunch.
      const setTitle = vi.fn(() => Promise.reject(new Error('EROFS')));
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      const input = startEditing(host);
      type(input, 'A name that will not save');
      press(input, 'Enter');
      expect(titleEl(host)!.textContent).toContain('A name that will not save'); // shown optimistically…
      await flush();
      expect(titleEl(host)!.textContent).toContain('Refactor the shadow parser'); // …then taken back
    });

    it('offers no editor for a PR or ticket title — that name is GitHub\'s, not the user\'s', () => {
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'pr', number: 57 } }));
      titleEl(host)!.click();
      expect(editor(host)).toBeNull();
    });

    it('offers no editor on a ref title — a PR name is GitHub\'s, not the user\'s to type', () => {
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'ticket', number: 42 } }));
      titleEl(host)!.click();
      expect(editor(host)).toBeNull();
    });

    it('offers no editor before a repo is known — there is no worktree to name', () => {
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'user', text: '' } }), null);
      titleEl(host)!.click();
      expect(editor(host)).toBeNull();
    });
  });

  describe('the engine activity', () => {
    it('names what the engine is doing', () => {
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Running reviewers' } }));
      expect(host.querySelector('.sb-activity')!.textContent).toContain('Running reviewers');
    });

    it('says nothing while the engine is idle', () => {
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Running reviewers' } }));
      render(model({ activity: null }));
      expect(host.querySelector('.sb-activity')!.textContent).toBe('');
    });

    it('announces politely, so a phrase change never interrupts what is being read', () => {
      const { host } = mount();
      const region = host.querySelector('.sb-activity')!;
      expect(region.getAttribute('aria-live')).toBe('polite');
    });

    it('does not re-announce an unchanged phrase on every push', () => {
      // The bar is repainted by every flow:onStateChanged push — a todo mutating, the agent flipping
      // active/quiet. Rebuilding the live region each time would re-announce "Working" over and over
      // while nothing about the engine actually changed (WCAG 4.1.3).
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Working' } }));
      const phrase = host.querySelector('.sb-activity .phrase');
      render(model({ activity: { phrase: 'Working' }, alert: blocked }));
      expect(host.querySelector('.sb-activity .phrase')).toBe(phrase); // same node → nothing re-announced
    });

    it('announces a phrase that really changed, without tearing down the region', () => {
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Working' } }));
      const region = host.querySelector('.sb-activity')!;
      render(model({ activity: { phrase: 'Running reviewers' } }));
      expect(host.querySelector('.sb-activity')).toBe(region); // the live region itself persists…
      expect(region.textContent).toContain('Running reviewers'); // …and the new phrase is what announces
      expect(region.querySelectorAll('.spin')).toHaveLength(1); // exactly one spinner, never a stacked pair
    });
  });

  describe('the attention state — the loop is blocked on a human', () => {
    it('names the status the loop is blocked at', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      expect(alertEl(host).textContent).toContain('awaiting-human-pr-approval');
    });

    it('announces assertively, interrupting — the human is the blocker (WCAG 4.1.3)', () => {
      const { host } = mount();
      const region = alertEl(host);
      const live = region.getAttribute('aria-live') === 'assertive' || region.getAttribute('role') === 'alert';
      expect(live).toBe(true);
    });

    it('clears only when the loop leaves the human-needed status — there is nothing to dismiss', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      expect(alertBtn(host)).not.toBeNull();
      expect(host.querySelector('[data-attn-dismiss]')).toBeNull(); // the ✕ is gone
      render(model({ alert: null }));
      expect(alertEl(host).textContent).toBe('');
    });

    it('coexists with the title and the activity — no element suppresses another', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named work' }, activity: { phrase: 'Working' }, alert: blocked }));
      expect(titleEl(host)!.textContent).toContain('Named work');
      expect(host.querySelector('.sb-activity')!.textContent).toContain('Working');
      expect(alertEl(host).textContent).toContain('awaiting-human-pr-approval');
    });

    it('does not re-announce an unchanged occurrence pushed again', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      const first = alertBtn(host);
      render(model({ alert: blocked }));
      expect(alertBtn(host)).toBe(first); // not rebuilt → not re-announced
    });

    it('re-announces when the loop reaches a distinct human-needed occurrence', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      const first = alertBtn(host);
      render(model({ alert: { ...blocked, status: 'awaiting-human-impl-triage' } })); // same iteration, new status
      expect(alertBtn(host)).not.toBe(first);
      expect(alertEl(host).textContent).toContain('awaiting-human-impl-triage');
    });

    it('re-announces the same occurrence reached in a different repo — it is a different loop', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }), '/repoA');
      const first = alertBtn(host);
      render(model({ alert: blocked }), '/repoB');
      expect(alertBtn(host)).not.toBe(first);
    });

    it('routes to the gate controls through its own contract, handing over its own button as the opener', () => {
      // The opener travels on the contract, not by a sibling sniffing [data-status-alert] out of this
      // organism's DOM — so focus-return still works when the bar is relocated (UI-STANDARDS §2.2 rule 4).
      const onAlertActivate = vi.fn();
      const { host, render } = mount({ onAlertActivate });
      render(model({ alert: blocked }));
      const btn = alertBtn(host)!;
      expect(btn.tagName).toBe('BUTTON'); // operable by keyboard natively (WCAG 2.1.1)
      btn.click();
      expect(onAlertActivate).toHaveBeenCalledTimes(1);
      expect(onAlertActivate).toHaveBeenCalledWith(btn);
    });

    it('names the panel it controls, so the relationship is programmatic (WCAG 4.1.2)', () => {
      const { host, render } = mount({ loopPanelId: 'loop-panel' });
      render(model({ alert: blocked }));
      expect(alertBtn(host)!.getAttribute('aria-controls')).toBe('loop-panel');
    });

    it('gives the alert an accessible name that CONTAINS its visible text (WCAG 2.5.3 label-in-name)', () => {
      // A speech-input user says what they see. The visible detail reads `... · iter 9 · PR #179`, so the
      // accessible name must contain those exact tokens — `pull request 179` is not `PR #179`.
      const { host, render } = mount();
      render(model({ alert: blocked }));
      const btn = alertBtn(host)!;
      const name = btn.getAttribute('aria-label') ?? btn.textContent ?? '';
      expect(name).toContain('iter 9');
      expect(name).toContain('PR #179');
      expect(name).toContain('Loop needs you');
    });

    it('strips control characters out of a repo-supplied status before it reaches the human (CWE-117)', () => {
      const { host, render } = mount();
      render(model({ alert: { ...blocked, status: 'awaiting\x00\x1bhuman' } }));
      expect(alertBtn(host)!.textContent).not.toMatch(/[\x00-\x1f]/);
    });
  });

  // CLAUDE.md: every payload carries the identity of the resource it acts on, and the receiver never
  // re-derives that target from ambient state. The editor commits on blur, and the cwd moves under it.
  describe('a name commits against the repo it was typed for', () => {
    it('commits to the repo the editor was opened in, even after the terminal has cd-ed elsewhere', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }), '/repoA');
      const input = edit(host);
      input.value = 'Refactor the shadow parser';
      render(model({ title: { kind: 'user', text: '' } }), '/repoB'); // a cd lands while the editor is open
      input.dispatchEvent(new FocusEvent('blur'));
      expect(setTitle).toHaveBeenCalledWith('/repoA', 'Refactor the shadow parser');
    });

    it('resolves a ref against the repo that asked for it, so another repo cannot answer for it', async () => {
      const githubRef = vi.fn(() => Promise.resolve(ref()));
      const { render } = mount({ githubRef });
      render(model({ title: { kind: 'pr', number: 7 } }), '/repoA');
      expect(githubRef).toHaveBeenCalledWith('/repoA', 'pr', 7);
      await flush();
      // The same ref NUMBER in a different repo is a different ref: a fetch issued for A must not land
      // on B's identically-numbered PR, painting one repo's private title into another's bar.
      githubRef.mockReturnValue(Promise.resolve(ref({ title: 'B secret', url: 'https://github.com/o/b/pull/7' })));
      render(model({ title: { kind: 'pr', number: 7 } }), '/repoB');
      expect(githubRef).toHaveBeenLastCalledWith('/repoB', 'pr', 7);
    });
  });

  describe('the editor never lies about what was saved, and never strands the keyboard', () => {
    it('commits once on Enter — the blur that follows the input being removed must not write again', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = edit(host);
      input.value = 'Named';
      press(input, 'Enter');
      input.dispatchEvent(new FocusEvent('blur')); // removing a focused element fires blur
      expect(setTitle).toHaveBeenCalledTimes(1);
    });

    it('abandons on Escape — and the blur that follows must not commit the name the user just discarded', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = edit(host);
      input.value = 'Discarded';
      press(input, 'Escape');
      input.dispatchEvent(new FocusEvent('blur'));
      expect(setTitle).not.toHaveBeenCalled();
    });

    it('returns focus to the name it replaced, rather than dropping it on the body (WCAG 2.4.3)', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' } }));
      const input = edit(host);
      input.focus();
      press(input, 'Enter');
      expect(document.activeElement).toBe(titleEl(host));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('returns focus after an abandoned edit too', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' } }));
      const input = edit(host);
      input.focus();
      press(input, 'Escape');
      expect(document.activeElement).toBe(titleEl(host));
    });

    it('does not strand focus on the body when a push replaces the focused title (WCAG 2.4.3)', () => {
      // A PR opens for the named work while the user has TAB-focused (not clicked) the name button; the
      // model-driven repaint removes that button. Focus must land on the control that replaced it, not <body>.
      const { host, render } = mount({ githubRef: () => Promise.resolve(null) });
      render(model({ title: { kind: 'user', text: 'Named' } }));
      titleEl(host)!.focus();
      render(model({ title: { kind: 'pr', number: 57 } }));
      expect(document.activeElement).toBe(titleEl(host));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not strand focus when a focused editable name becomes non-editable (WCAG 2.4.3)', () => {
      // Name the work in a repo (an editable button), tab-focus it, then leave the repo (repoKey null):
      // the title stays a `user` kind but is no longer editable, so it repaints as a span. Without a
      // tabindex the focus-restore would no-op and strand focus on <body>.
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' } }), REPO);
      titleEl(host)!.focus();
      render(model({ title: { kind: 'user', text: 'Named' } }), null); // cwd left the repo
      expect(document.activeElement).toBe(titleEl(host));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not strand focus when the alert clears while it is focused (WCAG 2.4.3)', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' }, alert: blocked }));
      alertBtn(host)!.focus();
      render(model({ title: { kind: 'user', text: 'Named' } })); // loop left the human-needed family
      expect(document.activeElement).not.toBe(document.body);
    });

    it('surfaces why a name could not be saved, rather than reverting with no reason given', async () => {
      const onError = vi.fn();
      const { host, render } = mount({ setTitle: () => Promise.reject('EROFS'), onError }); // a bare string, not an Error
      render(model({ title: { kind: 'user', text: '' } }));
      const input = edit(host);
      input.value = 'never lands';
      press(input, 'Enter');
      await flush();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0][0])).toContain('EROFS');
    });

    it('does not claw back a name the user has since replaced when a slow rejection finally lands', async () => {
      let reject: (e: unknown) => void = () => {};
      const setTitle = vi
        .fn()
        .mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
        .mockImplementation(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }));
      const first = edit(host);
      first.value = 'First';
      press(first, 'Enter');
      const second = edit(host);
      second.value = 'Second';
      press(second, 'Enter');
      reject(new Error('EROFS')); // the FIRST write's rejection, arriving after the second name was typed
      await flush();
      expect(titleEl(host)!.textContent).toBe('Second');
    });
  });

  describe('a control is offered only where it can act', () => {
    it('does not present an unresolvable ref as an operable control (WCAG 4.1.2)', async () => {
      // `gh` absent, offline, or the repo private: the number stays, but a button that swallows every
      // click advertises an action it can never perform.
      const { host, render } = mount({ githubRef: () => Promise.resolve(null) });
      render(model({ title: { kind: 'pr', number: 179 } }));
      await flush();
      expect(titleEl(host)!.textContent).toBe('PR #179');
      expect(titleEl(host)!.tagName).not.toBe('BUTTON');
    });

    it('upgrades the ref to an operable link once a url is actually in hand', async () => {
      const openExternal = vi.fn();
      const { host, render } = mount({ githubRef: () => Promise.resolve(ref()), openExternal });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      const link = titleEl(host)!;
      expect(link.textContent).toBe('Persist flow inputs across steps');
      expect(link.getAttribute('role')).toBe('link'); // it navigates; it does not act (WAI-ARIA APG)
      link.click();
      expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/57');
    });

    it('never opens the ref the bar has moved off, once it moves to one that never resolves', async () => {
      const openExternal = vi.fn();
      const githubRef = vi.fn().mockResolvedValueOnce(ref()).mockResolvedValue(null);
      const { host, render } = mount({ githubRef, openExternal });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      render(model({ title: { kind: 'ticket', number: 42 } }));
      await flush();
      titleEl(host)!.click();
      expect(openExternal).not.toHaveBeenCalled();
    });
  });

  it('disposes to an empty host (UI-STANDARDS clean teardown)', () => {
    const { host, bar, render } = mount();
    render(model({ title: { kind: 'user', text: 'x' }, alert: blocked }));
    bar.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('does not commit a half-typed name as a side effect of being torn down', () => {
    // dispose() detaches the focused input, which fires blur — and blur commits. A teardown must not
    // write what the user never finished typing.
    const setTitle = vi.fn(() => Promise.resolve());
    const { host, bar, render } = mount({ setTitle });
    render(model({ title: { kind: 'user', text: '' } }));
    const input = edit(host);
    input.value = 'half-typ';
    bar.dispose();
    input.dispatchEvent(new FocusEvent('blur'));
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('renders from the host document (relocatable, UI-STANDARDS §2.2)', async () => {
    await assertRendersFromHostDocument((host) =>
      createStatusBar(host, {
        githubRef: () => Promise.resolve(null),
        openExternal: () => {},
        setTitle: () => Promise.resolve(),
        onAlertActivate: () => {},
        onError: () => {},
        loopPanelId: 'loop-panel',
      }).render(model({ alert: blocked }), REPO),
    );
  });

  // UI-STANDARDS §3.3: relocatability is only true when a test proves it — the SAME organism, unchanged,
  // in TWO placements, with the SAME behavioral assertions run against both.
  it('behaves identically in two different placements (UI-STANDARDS §3.3 relocation)', () => {
    const place = (): { host: HTMLElement; onAlertActivate: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } => {
      const onAlertActivate = vi.fn();
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ onAlertActivate, setTitle });
      render(model({ title: { kind: 'user', text: 'Named' }, activity: { phrase: 'Working' }, alert: blocked }));
      return { host, onAlertActivate, setTitle };
    };
    const railFrame = document.createElement('section'); // two genuinely different placements
    const mainFrame = document.createElement('main');
    document.body.append(railFrame, mainFrame);

    const a = place();
    const b = place();
    railFrame.appendChild(a.host);
    mainFrame.appendChild(b.host);

    for (const p of [a, b]) {
      expect(p.host.querySelector('.sb-activity')!.textContent).toContain('Working');
      alertBtn(p.host)!.click();
      expect(p.onAlertActivate).toHaveBeenCalledTimes(1); // the alert routes from either frame
      const input = edit(p.host);
      input.value = 'Renamed';
      press(input, 'Enter');
      expect(p.setTitle).toHaveBeenCalledWith(REPO, 'Renamed'); // and the name commits from either frame
    }
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
  });
});
