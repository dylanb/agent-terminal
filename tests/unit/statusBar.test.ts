// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStatusBar, type StatusBarDeps } from '../../src/renderer/src/statusBar';
import { assertRendersFromHostDocument } from './relocatable';
import type { StatusBarModel } from '../../src/shared/statusBar';
import type { GithubRef } from '../../src/shared/ipc';


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
    onOpenError: deps.onOpenError ?? (() => {}),
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
      const { host } = mount();
      expect(host.hidden).toBe(false);
      expect(alertEl(host)).not.toBeNull();
      expect(host.querySelector('.sb-activity')).not.toBeNull();
    });

    it('exposes no focusable control inside a live region it has nothing to say in', () => {
      const { host, render } = mount();
      render(model());
      expect(alertEl(host).querySelector('button, [tabindex]')).toBeNull();
      expect(host.querySelector('.sb-activity')!.querySelector('button, [tabindex]')).toBeNull();
    });

    it('invites a name before it is handed anything at all', () => {
      const { host } = mount();
      expect(titleEl(host)).not.toBeNull();
      expect(titleEl(host)!.textContent!.length).toBeGreaterThan(0);
    });
  });

  describe('the title names the work — the PR, else the ticket, else the user', () => {
    it('shows the PR number at once and upgrades it to the fetched title', async () => {
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

    it.each([
      ['rejected promise', () => Promise.reject('no browser'), 'no browser'],
      ['explicit refusal', () => Promise.resolve(false), 'the operating system refused the link'],
    ])('surfaces a failed external open (%s)', async (_case, outcome, expected) => {
      const onOpenError = vi.fn();
      const openExternal = vi.fn(outcome);
      const { host, render } = mount({ githubRef: () => Promise.resolve(ref()), openExternal, onOpenError });
      render(model({ title: { kind: 'pr', number: 57 } }));
      await flush();
      titleEl(host)!.click();
      await flush();
      expect(onOpenError).toHaveBeenCalledWith(expected);
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

    it('names a populated title button as a rename control while retaining its visible label', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      expect(titleEl(host)!.getAttribute('aria-label')).toBe('Rename work: Refactor the shadow parser');
    });

    it('invites a name when the work is unnamed', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: '' } }));
      expect(titleEl(host)!.textContent!.length).toBeGreaterThan(0);
    });

    it('invites a name in a directory whose flow never loaded — the case where nothing else can name it', () => {
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
      render(model({ title: { kind: 'pr', number: 57 } }));
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
      press(input, 'Enter');
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
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'user', text: '' } }));
      const input = startEditing(host);
      type(input, 'half a nam');
      render(model({ title: { kind: 'user', text: '' }, activity: { phrase: 'Working' } }));
      expect(editor(host)).toBe(input);
      expect(editor(host)!.value).toBe('half a nam');
    });

    it('takes the name back when the write fails, rather than showing one that was never saved', async () => {
      const setTitle = vi.fn(() => Promise.reject(new Error('EROFS')));
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Refactor the shadow parser' } }));
      const input = startEditing(host);
      type(input, 'A name that will not save');
      press(input, 'Enter');
      expect(titleEl(host)!.textContent).toContain('A name that will not save');
      await flush();
      expect(titleEl(host)!.textContent).toContain('Refactor the shadow parser');
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
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Working' } }));
      const phrase = host.querySelector('.sb-activity .phrase');
      render(model({ activity: { phrase: 'Working' }, alert: blocked }));
      expect(host.querySelector('.sb-activity .phrase')).toBe(phrase);
    });

    it('announces a phrase that really changed, without tearing down the region', () => {
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Working' } }));
      const region = host.querySelector('.sb-activity')!;
      render(model({ activity: { phrase: 'Running reviewers' } }));
      expect(host.querySelector('.sb-activity')).toBe(region);
      expect(region.textContent).toContain('Running reviewers');
      expect(region.querySelectorAll('.spin')).toHaveLength(1);
    });

    it('reuses the phrase node across a changed phrase, updating only its text', () => {
      const { host, render } = mount();
      render(model({ activity: { phrase: 'Working' } }));
      const phraseNode = host.querySelector('.sb-activity .phrase');
      render(model({ activity: { phrase: 'Running reviewers' } }));
      expect(host.querySelector('.sb-activity .phrase')).toBe(phraseNode);
      expect(phraseNode!.textContent).toBe('Running reviewers');
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
      expect(host.querySelector('[data-attn-dismiss]')).toBeNull();
      render(model({ alert: null }));
      expect(alertEl(host).textContent).toBe('');
    });

    it('updates alert detail when a PR appears within the same status and iteration', () => {
      const { host, render } = mount();
      render(model({ alert: { ...blocked, pr: null } }));
      render(model({ alert: blocked }));
      expect(alertBtn(host)!.textContent).toContain('PR #179');
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
      expect(alertBtn(host)).toBe(first);
    });

    it('re-announces when the loop reaches a distinct human-needed occurrence', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      const first = alertBtn(host);
      render(model({ alert: { ...blocked, status: 'awaiting-human-impl-triage' } }));
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

    it('routes to the panel focus target through its own contract, handing over its own button as the opener', () => {
      const onAlertActivate = vi.fn();
      const { host, render } = mount({ onAlertActivate });
      render(model({ alert: blocked }));
      const btn = alertBtn(host)!;
      expect(btn.tagName).toBe('BUTTON');
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

  describe('a name commits against the repo it was typed for', () => {
    it('commits to the repo the editor was opened in without painting that name onto the new repo', () => {
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: '' } }), '/repoA');
      const input = edit(host);
      input.value = 'Refactor the shadow parser';
      render(model({ title: { kind: 'user', text: 'Repo B' } }), '/repoB');
      input.dispatchEvent(new FocusEvent('blur'));
      expect(setTitle).toHaveBeenCalledWith('/repoA', 'Refactor the shadow parser');
      expect(titleEl(host)!.textContent).toContain('Repo B');
      expect(titleEl(host)!.textContent).not.toContain('Refactor the shadow parser');
    });

    it('does not roll repo B back when repo A rejects the same optimistic title later', async () => {
      let rejectA: (reason: unknown) => void = () => {};
      const setTitle = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectA = reject)));
      const { host, render } = mount({ setTitle });
      render(model({ title: { kind: 'user', text: 'Repo A' } }), '/repoA');
      const input = edit(host);
      input.value = 'Shared title';
      press(input, 'Enter');
      render(model({ title: { kind: 'user', text: 'Shared title' } }), '/repoB');

      rejectA(new Error('EROFS'));
      await flush();
      expect(titleEl(host)!.textContent).toBe('Shared title');
    });

    it('resolves a ref against the repo that asked for it, so another repo cannot answer for it', async () => {
      let settleA: (value: GithubRef | null) => void = () => {};
      const githubRef = vi.fn((repoKey: string) =>
        repoKey === '/repoA'
          ? new Promise<GithubRef | null>((resolve) => { settleA = resolve; })
          : Promise.resolve(ref({ title: 'Repo B title', url: 'https://github.com/o/b/pull/7' })),
      );
      const { host, render } = mount({ githubRef });
      render(model({ title: { kind: 'pr', number: 7 } }), '/repoA');
      expect(githubRef).toHaveBeenCalledWith('/repoA', 'pr', 7);
      render(model({ title: { kind: 'pr', number: 7 } }), '/repoB');
      expect(githubRef).toHaveBeenLastCalledWith('/repoB', 'pr', 7);
      await flush();
      settleA(ref({ title: 'Repo A secret', url: 'https://github.com/o/a/pull/7' }));
      await flush();
      expect(titleEl(host)!.textContent).toContain('Repo B title');
      expect(titleEl(host)!.textContent).not.toContain('Repo A secret');
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
      input.dispatchEvent(new FocusEvent('blur'));
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
      const { host, render } = mount({ githubRef: () => Promise.resolve(null) });
      render(model({ title: { kind: 'user', text: 'Named' } }));
      titleEl(host)!.focus();
      render(model({ title: { kind: 'pr', number: 57 } }));
      expect(document.activeElement).toBe(titleEl(host));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not strand focus when a focused editable name becomes non-editable (WCAG 2.4.3)', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' } }), REPO);
      titleEl(host)!.focus();
      render(model({ title: { kind: 'user', text: 'Named' } }), null);
      expect(document.activeElement).toBe(titleEl(host));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not strand focus when the alert clears while it is focused (WCAG 2.4.3)', () => {
      const { host, render } = mount();
      render(model({ title: { kind: 'user', text: 'Named' }, alert: blocked }));
      alertBtn(host)!.focus();
      render(model({ title: { kind: 'user', text: 'Named' } }));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('surfaces why a name could not be saved, rather than reverting with no reason given', async () => {
      const onError = vi.fn();
      const { host, render } = mount({ setTitle: () => Promise.reject('EROFS'), onError });
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
      reject(new Error('EROFS'));
      await flush();
      expect(titleEl(host)!.textContent).toBe('Second');
    });

    it('does not surface an error for a superseded save whose slow rejection lands after a newer one', async () => {
      let reject: (e: unknown) => void = () => {};
      const setTitle = vi
        .fn()
        .mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
        .mockImplementation(() => Promise.resolve());
      const onError = vi.fn();
      const { host, render } = mount({ setTitle, onError });
      render(model({ title: { kind: 'user', text: '' } }));
      const first = edit(host);
      first.value = 'First';
      press(first, 'Enter');
      const second = edit(host);
      second.value = 'Second';
      press(second, 'Enter');
      reject(new Error('EROFS'));
      await flush();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('a control is offered only where it can act', () => {
    it('does not present an unresolvable ref as an operable control (WCAG 4.1.2)', async () => {
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
      expect(link.getAttribute('role')).toBe('link');
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
        onOpenError: () => {},
        loopPanelId: 'loop-panel',
      }).render(model({ alert: blocked }), REPO),
    );
  });

  it('behaves identically in two different placements (UI-STANDARDS §3.3 relocation)', () => {
    const place = (): { host: HTMLElement; onAlertActivate: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } => {
      const onAlertActivate = vi.fn();
      const setTitle = vi.fn(() => Promise.resolve());
      const { host, render } = mount({ onAlertActivate, setTitle });
      render(model({ title: { kind: 'user', text: 'Named' }, activity: { phrase: 'Working' }, alert: blocked }));
      return { host, onAlertActivate, setTitle };
    };
    const railFrame = document.createElement('section');
    const mainFrame = document.createElement('main');
    document.body.append(railFrame, mainFrame);

    const a = place();
    const b = place();
    railFrame.appendChild(a.host);
    mainFrame.appendChild(b.host);

    for (const p of [a, b]) {
      expect(p.host.querySelector('.sb-activity')!.textContent).toContain('Working');
      alertBtn(p.host)!.click();
      expect(p.onAlertActivate).toHaveBeenCalledTimes(1);
      const input = edit(p.host);
      input.value = 'Renamed';
      press(input, 'Enter');
      expect(p.setTitle).toHaveBeenCalledWith(REPO, 'Renamed');
    }
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
  });
});
