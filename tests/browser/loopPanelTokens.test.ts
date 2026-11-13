import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import type { FlowLoopView, FlowTokensView } from '../../src/shared/ipc';
import { tokenCellIn } from '../helpers/tokenCountsUi';

afterEach(() => document.body.replaceChildren());

type StepCounts = Extract<NonNullable<FlowTokensView['steps'][number]>, { state: 'counted' }>;
const kinds = (cacheRead: number, cacheWrite: number, input: number, output: number): StepCounts['kinds'] => ({
  cacheRead: { reported: 'all', n: cacheRead },
  cacheWrite: { reported: 'all', n: cacheWrite },
  input: { reported: 'all', n: input },
  output: { reported: 'all', n: output },
});
const counted = (cacheRead: number, cacheWrite: number, input: number, output: number): StepCounts => ({ state: 'counted', billed: true, kinds: kinds(cacheRead, cacheWrite, input, output) });

const STEPS = ['groom', 'plan', 'red', 'green', 'refactor', 'verify', 'ship', 'retro'];
const tokens = (redCacheRead: number): { steps: string[]; tokens: FlowTokensView } => ({
  steps: STEPS,
  tokens: {
    steps: [counted(310_022, 21_004, 1_203, 404), counted(520_111, 33_016, 2_407, 818), counted(redCacheRead, 9_031, 615, 209), null, null, null, null, null],
    counting: 2,
    run: { state: 'counted', someStepsUnavailable: false, kinds: kinds(830_133 + redCacheRead, 63_051, 4_225, 1_431) },
  },
});

const gate: FlowLoopView = {
  status: 'complete',
  iteration: 2,
  pr: 179,
  branch: 'agent-loop/issue-29',
  ready: false,
  actionable: true,
  gateOptions: ['approve', 'impasse'],
  appTurn: { step: 'red', turnKey: 'consolidate-red' },
  catalog: ['principal', 'tests', 'security', 'taint', 'reliability', 'maintainability', 'architecture', 'conventions'],
};

/** The nearest ancestor of `el` that scrolls its content. */
function scrollerOf(el: Element): HTMLElement {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (at.scrollHeight > at.clientHeight && getComputedStyle(at).overflowY !== 'visible') return at;
  }
  throw new Error('nothing scrolls around the token table');
}

const frames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

it('a push that changes only the counts keeps the panel body where it was scrolled and the gate control focused', async () => {
  const host = document.createElement('aside');
  host.className = 'loop-panel';
  host.style.height = '320px';
  host.style.width = '340px';
  document.body.append(host);
  const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {} });
  panel.render(gate, 'red', undefined, tokens(1_204_017));

  const approve = page.elementLocator(host).getByRole('button', { name: 'approve', exact: true }).element() as HTMLElement;
  approve.focus();
  const scroller = scrollerOf(tokenCellIn(host, 'red', 'cacheRead'));
  scroller.scrollTop = Math.floor((scroller.scrollHeight - scroller.clientHeight) / 2);
  await frames();
  const scrolledTo = scroller.scrollTop;

  panel.render(gate, 'red', undefined, tokens(1_309_441));
  await frames();

  expect({
    red: (tokenCellIn(host, 'red', 'cacheRead').textContent ?? '').replace(/\s+/g, ' ').trim(),
    scrolled: scrolledTo > 0,
    scrollTop: scroller.scrollTop,
    focusKept: document.activeElement === approve && approve.isConnected,
  }).toEqual({ red: '1,309,441 counting', scrolled: true, scrollTop: scrolledTo, focusKept: true });
});
