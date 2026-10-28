// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cardHeaderIn, cardIn, dismissIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

it.each(['header', 'dismiss'] as const)('keeps directory focus from %s when reconnection resets collapse choice', control => {
  const first = { ...statusTerminal(), id: 'first', launchDirectory: '/first' };
  const target = { ...statusTerminal(), id: 'old', launchDirectory: '/target', status: 'disconnected' as const };
  const { host, service, dispose } = mountControllerPanes({ terminals: [first, target] });
  try {
    const card = cardIn(host, target.launchDirectory)!;
    const header = cardHeaderIn(card, target.launchDirectory)!;
    if (control === 'header') header.click();
    const focused = control === 'header' ? header : dismissIn(card)!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    service.publish([first, { ...target, id: 'replacement', status: 'connected' }]);
    const replacementHeader = cardHeaderIn(cardIn(host, target.launchDirectory)!, target.launchDirectory)!;
    expect.soft(document.activeElement).toBe(replacementHeader);
    expect.soft(replacementHeader.getAttribute('aria-expanded')).toBe('true');
  } finally { dispose(); }
});
