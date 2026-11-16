import { directoryCards } from '../../src/shared/controllerCards';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/tokens.css';
import '../../src/renderer/src/styles.css';
import { createControllerCard, type ControllerCard } from '../../src/renderer/src/controllerCard';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardHeaderIn, cardIn, showFullReasonsIn, showsFullReason } from '../helpers/controllerCards';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const long = (name: string) => [1, 2, 3, 4, 5].map(line => `${name} line ${line}`).join('\n');
const FIRST = long('First');
const SECOND = long('Second');
const blocked = (...reasons: string[]): ControllerTerminal => statusTerminal({ attention: { status: 'complete', reasons } });
const directory = statusTerminal().launchDirectory;

function setup() {
  const host = document.createElement('div');
  host.style.width = '320px';
  document.body.append(host);
  let current: ControllerCard | undefined;
  const deps = (terminal: ControllerTerminal, expandedByDefault: boolean) =>
    ({ card: directoryCards([terminal])[0], expandedByDefault, timeText: 'for 3m', onAction() {}, onDismissLoopMessage() {} });
  const build = (terminal: ControllerTerminal, expandedByDefault = true) => {
    current = createControllerCard(host, deps(terminal, expandedByDefault));
    return current;
  };
  const update = (terminal: ControllerTerminal, expandedByDefault = true) => {
    current!.update(directoryCards([terminal])[0]);
    current!.setExpandedByDefault(expandedByDefault);
    return current!;
  };
  const reasonControls = () => { const card = cardIn(host, directory); return card ? showFullReasonsIn(card) : []; };
  const header = () => { const card = cardIn(host, directory); return card ? cardHeaderIn(card, directory) : undefined; };
  const expanded = () => header()?.getAttribute('aria-expanded');
  return { build, update, reasonControls, header, expanded, bringForward: () => { const card = cardIn(host, directory); return card ? bringForwardIn(card) : undefined; } };
}

describe('a card updated with a new status', () => {
  it('keeps showing in full the reasons it showed in full that it still shows, and forgets the ones it stopped showing', () => {
    const { build, update, reasonControls } = setup();
    build(blocked(FIRST, SECOND));
    reasonControls()[1]?.click();
    update(blocked(FIRST, SECOND));
    const kept = reasonControls().map(showsFullReason);
    update(blocked(FIRST));
    update(blocked(FIRST, SECOND));
    expect({ kept, afterGoingAway: reasonControls().map(showsFullReason) })
      .toEqual({ kept: [false, true], afterGoingAway: [false, false] });
  });

  it('keeps focus on the control the operator focused, or moves it to its header when that control is gone', () => {
    const { build, update, reasonControls, header, bringForward } = setup();
    const focusAfter = (focus: () => HTMLElement | undefined, next: ControllerTerminal) => {
      focus()?.focus();
      update(next);
      const found = document.activeElement;
      return found === document.body ? 'none' : found === header() ? 'header' : found === bringForward() ? 'bring forward'
        : `reason ${reasonControls().indexOf(found as HTMLElement)}`;
    };
    build(blocked(FIRST, SECOND));
    expect({
      secondReason: focusAfter(() => reasonControls()[1], blocked(FIRST, SECOND)),
      header: focusAfter(header, blocked(FIRST, SECOND)),
      bringForward: focusAfter(bringForward, blocked(FIRST, SECOND)),
      reasonGone: focusAfter(() => reasonControls()[1], blocked(FIRST)),
      nothingFocused: focusAfter(() => { (document.activeElement as HTMLElement | null)?.blur(); return undefined; }, blocked(FIRST)),
    }).toEqual({ secondReason: 'reason 1', header: 'header', bringForward: 'bring forward', reasonGone: 'header', nothingFocused: 'none' });
  });

  it('keeps the operator\'s expand or collapse over any default, and follows the default until the operator chooses', () => {
    const { build, update, header, expanded } = setup();
    build(blocked(FIRST), false);
    const untoggled = [expanded(), update(blocked(FIRST), true) && expanded()];
    header()?.click();
    const chosen = expanded();
    const card = update(blocked(FIRST), true);
    const afterUpdate = expanded();
    card.setExpandedByDefault(true);
    expect({ untoggled, chosen, afterUpdate, afterNewDefault: expanded() })
      .toEqual({ untoggled: ['false', 'true'], chosen: 'false', afterUpdate: 'false', afterNewDefault: 'false' });
  });

  it('follows a changed default while the operator has not chosen', () => {
    const { build, expanded } = setup();
    const card = build(blocked(FIRST), false);
    card.setExpandedByDefault(true);
    expect(expanded()).toBe('true');
  });
});
