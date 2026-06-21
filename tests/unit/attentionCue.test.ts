// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createAttentionCue, type AttentionCueDeps } from '../../src/renderer/src/attentionCue';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowLoopView } from '../../src/shared/ipc';

// §24.2.3 T4 — the awaiting-human attention cue. These assert only what a user/AT can observe: whether
// the cue is shown (visible, not display:none), the text it announces, that it announces assertively,
// that it self-clears on a non-human-needed/null view, that dismiss hides THIS occurrence while a
// distinct occurrence re-shows, and that dismiss does not drop keyboard focus to <body>. Visibility is
// a pure function of the loop view; the cue's only state is the dismissed occurrence, keyed per-repo.

const REPO = '/repo';

const human = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  pr: 179,
  branch: 'b',
  ready: false,
  humanNeeded: true,
  ...over,
});

function mount(deps?: AttentionCueDeps): {
  host: HTMLElement;
  cue: ReturnType<typeof createAttentionCue>;
  render: (loop: FlowLoopView | null, repoKey?: string | null) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const cue = createAttentionCue(host, deps);
  return { host, cue, render: (loop, repoKey = REPO) => cue.render(loop, repoKey) };
}
const shown = (host: HTMLElement): boolean => host.childElementCount > 0 && !host.hidden;
const dismissBtn = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('[data-attn-dismiss]')!;

describe('attention cue (§24.2.3 T4)', () => {
  it('shows on a human-needed view, naming the current status', () => {
    const { host, render } = mount();
    render(human());
    expect(shown(host)).toBe(true);
    expect(host.textContent).toContain('awaiting-human-pr-approval');
  });

  it('hides on a non-human-needed view', () => {
    const { host, render } = mount();
    render(human());
    render(human({ status: 'impl-draft', humanNeeded: false }));
    expect(shown(host)).toBe(false);
  });

  it('hides on a null mirror (loop state cannot be determined)', () => {
    const { host, render } = mount();
    render(human());
    render(null);
    expect(shown(host)).toBe(false);
  });

  it('announces assertively (interrupting) so assistive tech is alerted at once (WCAG 4.1.3)', () => {
    const { host, render } = mount();
    render(human());
    const live = host.getAttribute('aria-live') === 'assertive' || host.getAttribute('role') === 'alert';
    expect(live).toBe(true);
  });

  it('does not re-announce an unchanged (status, iteration) occurrence', () => {
    const { host, render } = mount();
    render(human());
    const first = host.querySelector('[data-attn-msg]');
    render(human()); // same occurrence pushed again — must not rebuild/re-announce
    expect(host.querySelector('[data-attn-msg]')).toBe(first);
  });

  it('re-shows on a distinct (status, iteration) occurrence', () => {
    const { host, render } = mount();
    render(human());
    render(human({ status: 'impl-draft', humanNeeded: false })); // leaves human-needed
    render(human({ status: 'awaiting-human-impl-triage', iteration: 11 }));
    expect(shown(host)).toBe(true);
    expect(host.textContent).toContain('awaiting-human-impl-triage');
  });

  it('re-announces when the human-needed status changes within the SAME iteration', () => {
    // AC: moving directly from one human-needed status to a different one within one iteration is a
    // distinct entry — the cue must rebuild and name the new status, not silently keep the old one.
    const { host, render } = mount();
    render(human({ status: 'awaiting-human-pr-approval', iteration: 9 }));
    const first = host.querySelector('[data-attn-msg]');
    render(human({ status: 'awaiting-human-impl-triage', iteration: 9 }));
    expect(shown(host)).toBe(true);
    expect(host.textContent).toContain('awaiting-human-impl-triage');
    expect(host.querySelector('[data-attn-msg]')).not.toBe(first); // rebuilt → re-announced
  });

  it('stays hidden for the dismissed occurrence, even when the same view is pushed again', () => {
    const { host, render } = mount();
    render(human());
    dismissBtn(host).click();
    expect(shown(host)).toBe(false);
    render(human()); // same occurrence re-pushed (e.g. a live re-pull) → stays dismissed
    expect(shown(host)).toBe(false);
  });

  it('re-shows after a dismiss when a distinct human-needed occurrence arrives', () => {
    const { host, render } = mount();
    render(human());
    dismissBtn(host).click();
    render(human({ iteration: 10 }));
    expect(shown(host)).toBe(true);
  });

  it('re-shows after a dismiss when the SAME occurrence arrives for a different repo', () => {
    // The dismissed occurrence is per-repo: cd-ing to another repo that coincidentally sits at the
    // same status+iteration is a distinct, never-dismissed loop and must re-show (§16.3 per-repo loop).
    const { host, render } = mount();
    render(human(), '/repoA');
    dismissBtn(host).click();
    expect(shown(host)).toBe(false);
    render(human(), '/repoB');
    expect(shown(host)).toBe(true);
  });

  it('keeps repo A dismissed after a detour to repo B at the same occurrence (per-repo dismissal store)', () => {
    // §16.3: the dismissed store is keyed per repo. cd A→B→A must not forget A's dismissal when B's
    // dismissal is recorded — a single global slot would overwrite A and wrongly re-show it on return.
    const { host, render } = mount();
    render(human(), '/repoA');
    dismissBtn(host).click();
    render(human(), '/repoB'); // distinct loop — shows
    expect(shown(host)).toBe(true);
    dismissBtn(host).click(); // dismiss B
    render(human(), '/repoA'); // back to A at the unchanged occurrence — still dismissed
    expect(shown(host)).toBe(false);
  });

  it('keeps the role=alert live region attached and not [hidden] when empty so injected content announces (WCAG 4.1.3)', () => {
    // WAI-ARIA Alert pattern: the live region must already be in the a11y tree when content is injected,
    // else AT registering regions at paint-time can drop the announcement. The empty state collapses via
    // CSS (:empty), never display:none/[hidden], so the region persists across hide/show cycles.
    const { host, render } = mount();
    expect(host.getAttribute('role')).toBe('alert');
    expect(host.hidden).toBe(false);
    render(human());
    render(null);
    expect(host.childElementCount).toBe(0);
    expect(host.hidden).toBe(false);
    // empty ⟺ no focusable descendant — the persistent region must not reintroduce the v2.44 trap.
    expect(host.querySelector('button, [tabindex]')).toBeNull();
  });

  it('moves focus off the cue on dismiss so it does not drop to <body> (WCAG 2.4.3)', () => {
    const onDismiss = vi.fn();
    const { host, render } = mount({ onDismiss });
    render(human());
    const btn = dismissBtn(host);
    btn.focus();
    expect(host.contains(document.activeElement)).toBe(true);
    btn.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not relocate focus on dismiss when focus was not on the cue', () => {
    const onDismiss = vi.fn();
    const { host, render } = mount({ onDismiss });
    render(human());
    dismissBtn(host).click(); // jsdom .click() does not focus the button
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('disposes to an empty host (UI-STANDARDS clean teardown)', () => {
    const { host, cue, render } = mount();
    render(human());
    cue.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('signals a layout change (resize) only when its shown/hidden state flips, so the terminal refits', () => {
    const { render } = mount();
    let resizes = 0;
    const onResize = (): void => {
      resizes += 1;
    };
    window.addEventListener('resize', onResize);
    try {
      render(human()); // hidden → shown: the viewport shrank
      expect(resizes).toBe(1);
      render(human({ status: 'awaiting-human-impl-triage', iteration: 11 })); // still shown: no flip
      expect(resizes).toBe(1);
      render(null); // shown → hidden: the viewport grew
      expect(resizes).toBe(2);
    } finally {
      window.removeEventListener('resize', onResize);
    }
  });

  it('renders from the host document (relocatable, UI-STANDARDS §2.2)', async () => {
    await assertRendersFromHostDocument((host) => createAttentionCue(host).render(human(), REPO));
  });
});
