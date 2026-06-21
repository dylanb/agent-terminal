// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createAttentionCue } from '../../src/renderer/src/attentionCue';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowLoopView } from '../../src/shared/ipc';

// §24.2.3 T4 — the awaiting-human attention cue. These assert only what a user/AT can observe: whether
// the cue is shown (visible, not display:none), the text it announces, that it announces assertively,
// that it self-clears on a non-human-needed/null view, and that dismiss hides THIS occurrence while a
// distinct occurrence re-shows. Visibility is a pure function of the loop view; the cue's only state
// is the dismissed occurrence.

const human = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  pr: 179,
  branch: 'b',
  ready: false,
  humanNeeded: true,
  ...over,
});

function mount(): { host: HTMLElement; cue: ReturnType<typeof createAttentionCue> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { host, cue: createAttentionCue(host) };
}
const shown = (host: HTMLElement): boolean => host.childElementCount > 0 && !host.hidden;
const dismissBtn = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('[data-attn-dismiss]')!;

describe('attention cue (§24.2.3 T4)', () => {
  it('shows on a human-needed view, naming the current status', () => {
    const { host, cue } = mount();
    cue.render(human());
    expect(shown(host)).toBe(true);
    expect(host.textContent).toContain('awaiting-human-pr-approval');
  });

  it('hides on a non-human-needed view', () => {
    const { host, cue } = mount();
    cue.render(human());
    cue.render(human({ status: 'impl-draft', humanNeeded: false }));
    expect(shown(host)).toBe(false);
  });

  it('hides on a null mirror (loop state cannot be determined)', () => {
    const { host, cue } = mount();
    cue.render(human());
    cue.render(null);
    expect(shown(host)).toBe(false);
  });

  it('announces assertively (interrupting) so assistive tech is alerted at once (WCAG 4.1.3)', () => {
    const { host, cue } = mount();
    cue.render(human());
    const live = host.getAttribute('aria-live') === 'assertive' || host.getAttribute('role') === 'alert';
    expect(live).toBe(true);
  });

  it('does not re-announce an unchanged (status, iteration) occurrence', () => {
    const { host, cue } = mount();
    cue.render(human());
    const first = host.querySelector('[data-attn-msg]');
    cue.render(human()); // same occurrence pushed again — must not rebuild/re-announce
    expect(host.querySelector('[data-attn-msg]')).toBe(first);
  });

  it('re-shows on a distinct (status, iteration) occurrence', () => {
    const { host, cue } = mount();
    cue.render(human());
    cue.render(human({ status: 'impl-draft', humanNeeded: false })); // leaves human-needed
    cue.render(human({ status: 'awaiting-human-impl-triage', iteration: 11 }));
    expect(shown(host)).toBe(true);
    expect(host.textContent).toContain('awaiting-human-impl-triage');
  });

  it('stays hidden for the dismissed occurrence, even when the same view is pushed again', () => {
    const { host, cue } = mount();
    cue.render(human());
    dismissBtn(host).click();
    expect(shown(host)).toBe(false);
    cue.render(human()); // same occurrence re-pushed (e.g. a live re-pull) → stays dismissed
    expect(shown(host)).toBe(false);
  });

  it('re-shows after a dismiss when a distinct human-needed occurrence arrives', () => {
    const { host, cue } = mount();
    cue.render(human());
    dismissBtn(host).click();
    cue.render(human({ iteration: 10 }));
    expect(shown(host)).toBe(true);
  });

  it('renders from the host document (relocatable, UI-STANDARDS §2.2)', async () => {
    await assertRendersFromHostDocument((host) => createAttentionCue(host).render(human()));
  });
});
