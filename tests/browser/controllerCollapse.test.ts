import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { cardHeaderIn, cardIn, cardLocator, headerActivationIn, clearHistoryLocator, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';
import { statusItem } from '../helpers/controllerHistory';

afterEach(() => document.body.replaceChildren());

const working = { ...statusTerminal(), id: 'working', launchDirectory: '/cards/working', timeline: [statusItem('Went quiet', 1000)] };
const DIRECTORY = working.launchDirectory;

async function tabTo(target: HTMLElement | undefined): Promise<boolean> {
  for (let presses = 0; target && document.activeElement !== target && presses < 60; presses += 1) await userEvent.tab();
  return Boolean(target) && document.activeElement === target;
}

/** Clicks `control` as a pointer does; a missing control shows in the state reads instead of throwing here. */
async function click(control: HTMLElement | undefined): Promise<void> {
  if (control) await userEvent.click(control);
}

it('toggles a card once per click, Enter and Space on its header, flipping its expanded state and its body together and keeping focus', async () => {
  const { host, service, dispose } = mountControllerPanes({ terminals: [working] });
  const header = () => { const card = cardIn(host, DIRECTORY); return card ? cardHeaderIn(card, DIRECTORY) : undefined; };
  const read = () => {
    const card = cardIn(host, DIRECTORY);
    const control = header();
    return {
      expanded: control?.getAttribute('aria-expanded') ?? 'no header',
      bodyPainted: Boolean(card && statusRowIn(card)?.checkVisibility({ visibilityProperty: true })),
      bodyInTree: clearHistoryLocator(cardLocator(page.elementLocator(host), DIRECTORY)).query() !== null,
      focused: control !== undefined && document.activeElement === control,
    };
  };
  try {
    const reached = await tabTo(header());
    const initial = read();
    await click(header());
    const clicked = read();
    await userEvent.keyboard('{Enter}');
    const entered = read();
    await userEvent.keyboard(' ');
    const spaced = read();
    const open = { expanded: 'true', bodyPainted: true, bodyInTree: true, focused: true };
    const shut = { expanded: 'false', bodyPainted: false, bodyInTree: false, focused: true };
    expect({ reached, initial, clicked, entered, spaced, activated: [...service.activated] })
      .toEqual({ reached: true, initial: open, clicked: shut, entered: open, spaced: shut, activated: [] });
  } finally { dispose(); }
});

it.each([
  { where: 'collapsed', oneColumn: true, expanded: 'false' },
  { where: 'expanded', oneColumn: false, expanded: 'true' },
])('brings the terminal forward once per click, Enter and Space on the header icon of a $where card, leaving it $where', async ({ oneColumn, expanded }) => {
  const { host, service, dispose } = mountControllerPanes({ terminals: [working], oneColumn });
  const icon = () => { const card = cardIn(host, DIRECTORY); return card ? headerActivationIn(card) : undefined; };
  const read = () => {
    const card = cardIn(host, DIRECTORY);
    return { expanded: (card && cardHeaderIn(card, DIRECTORY))?.getAttribute('aria-expanded') ?? 'no header', activated: [...service.activated] };
  };
  const idle = () => expect.poll(() => icon()?.hasAttribute('aria-busy') ?? false).toBe(false);
  try {
    const reached = await tabTo(icon());
    const initial = read();
    await userEvent.keyboard('{Enter}');
    await idle();
    const entered = read();
    await userEvent.keyboard(' ');
    await idle();
    const spaced = read();
    await click(icon());
    await idle();
    const clicked = read();
    expect({ reached, initial, entered, spaced, clicked }).toEqual({
      reached: true,
      initial: { expanded, activated: [] },
      entered: { expanded, activated: [working.id] },
      spaced: { expanded, activated: [working.id, working.id] },
      clicked: { expanded, activated: [working.id, working.id, working.id] },
    });
  } finally { dispose(); }
});
