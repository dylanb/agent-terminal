// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStatusBar, type StatusBarDeps } from '../../src/renderer/src/statusBar';
import { assertRendersFromHostDocument } from './relocatable';
import type { StatusBarModel } from '../../src/shared/statusBar';
import type { GithubRef } from '../../src/shared/ipc';

// §22.3 — the always-visible status bar. It shows the work's title, what the engine is doing, and (in
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
  });
  return { host, bar, render: (m, repoKey = REPO) => bar.render(m, repoKey) };
}

const titleEl = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-sb-title]');
const alertEl = (host: HTMLElement): HTMLElement => host.querySelector('.sb-alert')!;
const alertBtn = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-status-alert]');
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('status bar (§22.3)', () => {
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
      expect(githubRef).toHaveBeenCalledWith('pr', 57);
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

    it('still shows a name slot — inert — for a flow that failed to load', () => {
      // Every directory without a flow.yaml IS a load-error view, so blanking the title here would blank
      // the bar in the commonest case of all. The machine is inert and must not persist in that state, so
      // the slot is shown but never offered as something to edit or open.
      const { host, render } = mount();
      render(model({ title: { kind: 'unavailable' } }));
      expect(titleEl(host)).not.toBeNull();
      expect(titleEl(host)!.tagName).not.toBe('BUTTON');
      expect(host.querySelector('button')).toBeNull();
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
      expect(setTitle).toHaveBeenCalledWith('Refactor the shadow parser');
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
      expect(setTitle).toHaveBeenCalledWith('Named by blur');
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
      expect(setTitle).toHaveBeenCalledWith('');
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

    it('offers no editor for a flow that failed to load — there is nowhere to persist a name', () => {
      const { host, render } = mount({ setTitle: () => Promise.resolve() });
      render(model({ title: { kind: 'unavailable' } }));
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

    it('offers the gate controls: the alert is a button the shell opens the loop panel from', () => {
      const { host, render } = mount();
      render(model({ alert: blocked }));
      expect(alertBtn(host)!.tagName).toBe('BUTTON'); // operable by keyboard natively (WCAG 2.1.1)
    });
  });

  it('disposes to an empty host (UI-STANDARDS clean teardown)', () => {
    const { host, bar, render } = mount();
    render(model({ title: { kind: 'user', text: 'x' }, alert: blocked }));
    bar.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('renders from the host document (relocatable, UI-STANDARDS §2.2)', async () => {
    await assertRendersFromHostDocument((host) =>
      createStatusBar(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, setTitle: () => Promise.resolve() }).render(
        model({ alert: blocked }),
        REPO,
      ),
    );
  });
});
