import { afterEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/tokens.css';
import '../../src/renderer/src/styles.css';
import { cardIn, headerLabels, paintedStatusIn, statusRowIn, unshownCounts, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { WAITING_STATUS_CASES, type WaitingStatusCase } from '../helpers/controllerStatusFixture';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

const cases = Object.entries(WAITING_STATUS_CASES);
const flowLine = (c: WaitingStatusCase): string => {
  const flow = c.terminal.work?.flow;
  return flow?.availability === 'known' ? `Flow: ${flow.name} — Step: ${flow.step}` : 'Flow loading';
};

/** The card text after its flow line, where its activity line is; the status row and header come before it. */
function afterFlowLine(card: HTMLElement | undefined, line: string): string {
  const text = card?.textContent ?? '';
  const at = text.indexOf(line);
  return at < 0 ? `no flow line in ${JSON.stringify(text)}` : text.slice(at + line.length);
}

describe.each(['light', 'dark'])('Waiting cards in the %s theme', theme => {
  it('show their written status painted in their status class, an activity line naming the program, and count in the header', () => {
    document.documentElement.setAttribute('data-theme', theme);
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(([, c]) => c.terminal) });
    try {
      const shown = Object.fromEntries(cases.map(([key, c]) => {
        const card = cardIn(host, c.terminal.launchDirectory);
        return [key, card ? {
          status: statusRowIn(card)?.textContent?.trim(),
          painted: paintedStatusIn(card),
          activityLine: afterFlowLine(card, flowLine(c)).includes(c.activity),
        } : 'no card'];
      }));
      const rows: WaitingStatusCase[] = cases.map(([, c]) => c);
      const counts = unshownCounts(windowHeaderIn(host)?.textContent ?? '', headerLabels(label => rows.filter(c => c.summary === label).length, rows.length, rows.length));
      expect({ shown, counts }).toEqual({
        shown: Object.fromEntries(cases.map(([key, c]) => [key, { status: c.text, painted: { accent: c.statusClass, text: c.statusClass }, activityLine: true }])),
        counts: [],
      });
    } finally { dispose(); }
  });
});
