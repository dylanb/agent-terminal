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

    it('exposes no focusable control while it has nothing to act on', () => {
      const { host, render } = mount();
      render(model());
      expect(host.querySelector('button, [tabindex]')).toBeNull();
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
      createStatusBar(host, { githubRef: () => Promise.resolve(null), openExternal: () => {} }).render(
        model({ alert: blocked }),
        REPO,
      ),
    );
  });
});
