import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import {
  cardHeaderIn, cardIn, clearHistoryIn, dismissLoopMessageIn, headerActivationIn, listSequenceIn, showFullReasonIn, windowHeaderIn,
} from '../helpers/controllerCards';
import { heading, orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { statusItem } from '../helpers/controllerHistory';
import { mountControllerPanes } from '../helpers/controllerMount';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

afterEach(() => document.body.replaceChildren());

const MINUTE = 60_000;
const LONG_REASON = Array.from({ length: 40 }, (_, index) => `Review step ${index + 1} of the plan before it runs.`).join(' ');
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** `name`'s status-case terminal with a long reason, a history entry and a Clear history target, so every reading control shows. */
function readable(name: string, status: 'needs-human' | 'flow-error'): ControllerTerminal {
  const terminal = t(name, status);
  const work = terminal.work!;
  return {
    ...terminal,
    work: status === 'needs-human' ? { ...work, attention: { status: 'needs a human', reasons: [LONG_REASON] } } : { ...work, error: { reason: LONG_REASON } },
    timeline: [statusItem(`${name} went quiet`, 1_000)],
    clearHistoryTarget: { id: terminal.id, launchDirectory: terminal.launchDirectory, revision: 'r1' },
  };
}

it('keeps a Needs a human card and an Errors card in their groups while the operator reads and acts on them', async () => {
  const parent = document.body.appendChild(document.createElement('section'));
  parent.style.width = '360px';
  const terminals = [readable('e', 'flow-error'), readable('n', 'needs-human'), t('l', 'loop-error'), t('gone', 'disconnected'), t('i1', 'idle'), t('i2', 'idle')];
  const { host, service, clock, dispose } = mountControllerPanes({ terminals, parent, windowFocused: false });
  const directories = terminals.map(terminal => terminal.launchDirectory);
  const list = () => listSequenceIn(host, directories);
  const card = (name: string) => cardIn(host, d(name))!;
  const away = async () => {
    const header = windowHeaderIn(host);
    if (header) await userEvent.hover(header);
    (document.activeElement as HTMLElement | null)?.blur();
    await settled();
  };
  const press = async (control: HTMLElement | undefined) => {
    if (control) await userEvent.click(control);
    await away();
  };
  const readings: Array<[string, () => Promise<void>]> = ['e', 'n'].flatMap(name => [
    [`${name}: collapse`, () => press(cardHeaderIn(card(name), d(name)))],
    [`${name}: expand`, () => press(cardHeaderIn(card(name), d(name)))],
    [`${name}: hover`, async () => { await userEvent.hover(card(name)); await away(); }],
    [`${name}: focus`, async () => { cardHeaderIn(card(name), d(name))?.focus(); await away(); }],
    [`${name}: Show full reason`, () => press(showFullReasonIn(card(name)))],
    [`${name}: Clear history`, () => press(clearHistoryIn(card(name)))],
    [`${name}: Bring forward`, () => press(headerActivationIn(card(name)))],
  ] as Array<[string, () => Promise<void>]>);
  try {
    await settled();
    const reasonShown = { e: Boolean(showFullReasonIn(card('e'))), n: Boolean(showFullReasonIn(card('n'))) };
    const reading = [heading('errors', 3), d('e'), d('l'), d('gone'), heading('need a human', 1), d('n'), heading('idle', 2), d('i1'), d('i2')];
    const lists: Array<[string, string[]]> = [];
    for (const [action, act] of readings) {
      await act();
      lists.push([action, list()]);
    }
    expect.soft(reasonShown, 'Show full reason is offered on both cards').toEqual({ e: true, n: true });
    expect.soft(lists).toEqual(readings.map(([action]) => [action, reading]));
    clock.advance(MINUTE);
    await press(dismissLoopMessageIn(card('l')));
    await expect.poll(list).toEqual([heading('errors', 2), d('e'), d('gone'), heading('need a human', 1), d('n'), heading('idle', 3), d('i1'), d('i2'), d('l')]);
    expect(service.loopMessageDismissals).toEqual([[`order-l`, 'loop-1']]);
  } finally { dispose(); }
});
