import { directoryCards } from '../../src/shared/controllerCards';
import { afterEach, describe, expect, it } from 'vitest';
import '../helpers/rendererTokens';
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
  const build = (terminal: ControllerTerminal, from?: ReturnType<ControllerCard['state']>, expandedByDefault = true) => {
    current = createControllerCard(host, { card: directoryCards([terminal])[0], expandedByDefault, onAction() {}, from });
    return current;
  };
  const replace = (terminal: ControllerTerminal, expandedByDefault = true) => {
    const state = current!.state();
    current!.dispose();
    return build(terminal, state, expandedByDefault);
  };
  const reasonControls = () => { const card = cardIn(host, directory); return card ? showFullReasonsIn(card) : []; };
  const header = () => { const card = cardIn(host, directory); return card ? cardHeaderIn(card, directory) : undefined; };
  const expanded = () => header()?.getAttribute('aria-expanded');
  return { build, replace, reasonControls, header, expanded, bringForward: () => { const card = cardIn(host, directory); return card ? bringForwardIn(card) : undefined; } };
}

describe('a card built from the state of the card it replaces', () => {
  it('shows in full the reasons the old card showed in full that it still shows, and forgets the ones it does not', () => {
    const { build, replace, reasonControls } = setup();
    build(blocked(FIRST, SECOND));
    reasonControls()[1]?.click();
    replace(blocked(FIRST, SECOND));
    const kept = reasonControls().map(showsFullReason);
    replace(blocked(FIRST));
    replace(blocked(FIRST, SECOND));
    expect({ kept, afterGoingAway: reasonControls().map(showsFullReason) })
      .toEqual({ kept: [false, true], afterGoingAway: [false, false] });
  });

  it('offers as its focus target the control the old card had focused, or its header when that control is gone', () => {
    const { build, replace, reasonControls, header, bringForward } = setup();
    const target = (focus: () => HTMLElement | undefined, next: ControllerTerminal) => {
      focus()?.focus();
      const card = replace(next);
      const found = card.focusTarget();
      return found === undefined ? 'none' : found === header() ? 'header' : found === bringForward() ? 'bring forward'
        : `reason ${reasonControls().indexOf(found)}`;
    };
    build(blocked(FIRST, SECOND));
    expect({
      secondReason: target(() => reasonControls()[1], blocked(FIRST, SECOND)),
      header: target(header, blocked(FIRST, SECOND)),
      bringForward: target(bringForward, blocked(FIRST, SECOND)),
      reasonGone: target(() => reasonControls()[1], blocked(FIRST)),
      nothingFocused: target(() => { (document.activeElement as HTMLElement | null)?.blur(); return undefined; }, blocked(FIRST)),
      ownHeader: replace(blocked(FIRST)).header() === header(),
    }).toEqual({ secondReason: 'reason 1', header: 'header', bringForward: 'bring forward', reasonGone: 'header', nothingFocused: 'none', ownHeader: true });
  });

  it('keeps the operator\'s expand or collapse over any default, and follows the default until the operator chooses', () => {
    const { build, replace, header, expanded } = setup();
    build(blocked(FIRST), undefined, false);
    const untoggled = [expanded(), replace(blocked(FIRST), true) && expanded()];
    header()?.click();
    const chosen = expanded();
    const card = replace(blocked(FIRST), true);
    const afterRebuild = expanded();
    card.setExpandedByDefault(true);
    expect({ untoggled, chosen, afterRebuild, afterNewDefault: expanded() })
      .toEqual({ untoggled: ['false', 'true'], chosen: 'false', afterRebuild: 'false', afterNewDefault: 'false' });
  });

  it('follows a changed default while the operator has not chosen', () => {
    const { build, expanded } = setup();
    const card = build(blocked(FIRST), undefined, false);
    card.setExpandedByDefault(true);
    expect(expanded()).toBe('true');
  });
});
