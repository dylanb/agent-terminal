import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { bringForwardLocator, cardHeaderIn, cardIn, cardLocator, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const working = { ...statusTerminal(), id: 'working', launchDirectory: '/cards/working' };
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
      bodyInTree: bringForwardLocator(cardLocator(page.elementLocator(host), DIRECTORY)).query() !== null,
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
