// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cardStatus, statusSummary } from '../../src/shared/controllerCardClassification';
import { directoryCards } from '../../src/shared/controllerCards';
import { controllerTrayView } from '../../src/main/controllerTrayModel';
import { STATUS_CASES, WAITING_STATUS_CASES } from '../helpers/controllerStatusFixture';

const cases = Object.entries(WAITING_STATUS_CASES);

describe('a Waiting card', () => {
  it.each(cases)('%s: shows its written status in its status class and summary', (_, { terminal, text, statusClass, summary }) => {
    const actual = cardStatus(directoryCards([terminal])[0]);
    expect({ text: actual.text, statusClass: actual.statusClass, summary: actual.summary }).toEqual({ text, statusClass, summary });
  });

  it('counts under working in the header summary, with or without a pending request or error', () => {
    const terminals = [...cases.map(([, c]) => c.terminal), STATUS_CASES.idle.terminal];
    const counts = Object.fromEntries(statusSummary(directoryCards(terminals)).map(({ label, count }) => [label, count]));
    const expected = { errors: 0, 'need a human': 0, idle: 4, working: 5 };
    expect(counts).toEqual(expected);
  });

  it('counts as working in the tray, so a pending request or error on a Waiting card raises no tray badge', () => {
    const view = controllerTrayView(cases.map(([, c]) => c.terminal), false);
    expect({ badge: view.badge, errors: view.errors, needsHuman: view.needsHuman }).toEqual({ badge: 'none', errors: 0, needsHuman: 0 });
  });
});
