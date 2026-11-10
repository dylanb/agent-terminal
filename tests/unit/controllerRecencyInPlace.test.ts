// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cardHeaderIn, cardIn, headerActivationIn, listSequenceIn, selectedSortOptionsIn, sortOptionIn } from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const TERMINALS = [t('i1', 'idle'), t('e1', 'flow-error'), t('i2', 'idle')];
const DIRECTORIES = TERMINALS.map(terminal => terminal.launchDirectory);
const tasksRun = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function toggleOf(host: HTMLElement, name: string): HTMLElement {
  const card = cardIn(host, d(name));
  const toggle = card && cardHeaderIn(card, d(name));
  if (!toggle) throw new Error(`no header toggle for ${d(name)}`);
  return toggle;
}

/** Presses `name`'s header toggle with focus on it, and reports what the press left focused once its work has run. */
async function pressInPlace(host: HTMLElement, name: string) {
  const toggle = toggleOf(host, name);
  const expandedBefore = toggle.getAttribute('aria-expanded');
  toggle.focus();
  toggle.click();
  await tasksRun();
  return {
    toggled: toggle.getAttribute('aria-expanded') !== expandedBefore,
    focusStaysOnThePressedControl: document.activeElement === toggle && toggle.isConnected,
  };
}

async function inRecentlyUsed(host: HTMLElement): Promise<void> {
  const option = await vi.waitFor(() => {
    const found = sortOptionIn(host, 'Recently used');
    if (!found) throw new Error('the Recently used sort option is not shown yet');
    return found;
  });
  option.click();
  await vi.waitFor(() => expect(selectedSortOptionsIn(host)).toEqual(['Recently used']));
}

it('keeps focus on the very control pressed when a press in Attention order changes no card\'s place', async () => {
  const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
  try {
    expect(await pressInPlace(host, 'i2')).toEqual({ toggled: true, focusStaysOnThePressedControl: true });
  } finally { dispose(); }
});

it('keeps focus on the very control pressed when a press in Recently used order is on the card already first', async () => {
  const { host, dispose } = mountControllerPanes({ terminals: TERMINALS });
  try {
    await inRecentlyUsed(host);
    toggleOf(host, 'i2').click();
    (document.activeElement as HTMLElement | null)?.blur();
    const first = [RECENTLY_USED_HEADING, d('i2'), d('e1'), d('i1')];
    await vi.waitFor(() => expect(listSequenceIn(host, DIRECTORIES)).toEqual(first));
    expect(await pressInPlace(host, 'i2')).toEqual({ toggled: true, focusStaysOnThePressedControl: true });
  } finally { dispose(); }
});

it('shows a moved card\'s Bring forward busy while the press that moved it is answered, and takes no second press until then', async () => {
  const answers: Array<() => void> = [];
  const requested: string[] = [];
  const fake = statusService(TERMINALS).api;
  const { host, dispose } = mountControllerPanes({ controller: {
    ...fake,
    activateTerminal(id: string) { requested.push(id); return new Promise<'activated'>(done => { answers.push(() => done('activated')); }); },
  } });
  try {
    await inRecentlyUsed(host);
    const bringForward = () => headerActivationIn(cardIn(host, d('i2'))!);
    bringForward()!.click();
    (document.activeElement as HTMLElement | null)?.blur();
    const first = [RECENTLY_USED_HEADING, d('i2'), d('e1'), d('i1')];
    await vi.waitFor(() => expect(listSequenceIn(host, DIRECTORIES)).toEqual(first));
    const whilePending = { busy: bringForward()!.getAttribute('aria-busy') };
    bringForward()!.click();
    const requestedWhilePending = [...requested];
    answers.forEach(answer => answer());
    await vi.waitFor(() => expect(bringForward()!.hasAttribute('aria-busy')).toBe(false));
    bringForward()!.click();
    expect({ whilePending, requestedWhilePending, afterAnswer: requested })
      .toEqual({ whilePending: { busy: 'true' }, requestedWhilePending: ['order-i2'], afterAnswer: ['order-i2', 'order-i2'] });
  } finally { dispose(); }
});
