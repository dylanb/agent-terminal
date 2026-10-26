import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { cardIn, cardLocator } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const hoverText = (root: HTMLElement | undefined, text: string): boolean =>
  Boolean(root && [root, ...root.querySelectorAll<HTMLElement>('[title]')].some(element => element.title === text));

describe('long card text', () => {
  const directory = `/work/${'middle-segment-'.repeat(16)}final-segment`;
  const title = 'An over-long issue title that cannot fit on one card line '.repeat(4).trim();
  const terminal = { ...statusTerminal({ ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } } }), launchDirectory: directory };

  it('names and hovers an over-long directory in full', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: [terminal] });
    try {
      await expect.poll(() => {
        const card = cardIn(host, directory);
        return {
          card: Boolean(card),
          hover: hoverText(card, directory),
          named: cardLocator(page.elementLocator(host), directory).query() !== null,
        };
      }).toEqual({ card: true, hover: true, named: true });
    } finally { dispose(); }
  });

  it('gives an over-long ticket title its full text on hover and to assistive technology', () => {
    const { host, dispose } = mountControllerPanes({ terminals: [terminal] });
    try {
      const card = cardIn(host, directory);
      expect({ hover: hoverText(card, title), text: card?.textContent?.includes(title) ?? false }).toEqual({ hover: true, text: true });
    } finally { dispose(); }
  });
});
