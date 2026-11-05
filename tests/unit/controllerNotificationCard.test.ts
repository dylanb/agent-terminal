// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { directoryCards, type ControllerDirectoryCard } from '../../src/shared/controllerCards';
import { cardIn, entryAccessibleText, statusRowIn, timelineEntriesIn } from '../helpers/controllerCards';
import { notificationItem } from '../helpers/controllerHistory';
import { statusTerminal } from '../helpers/controllerStatusFixture';

const receivedAt = new Date(2026, 9, 28, 13, 24, 56).getTime();
const notification = notificationItem('Review the release proposal', receivedAt);

afterEach(() => document.body.replaceChildren());

it('shows a received message and receipt time separately from the current human-needed reason', () => {
  const terminal = { ...statusTerminal({ attention: { status: 'complete', reasons: ['Approve deployment'] } }), timeline: [notification] };
  const card: ControllerDirectoryCard = directoryCards([terminal])[0];
  const host = document.createElement('main');
  document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onAction() {}, onDismissLoopMessage() {} });
  try {
    const pane = cardIn(host, terminal.launchDirectory)!;
    const [received] = timelineEntriesIn(pane);
    expect.soft(received?.textContent ?? '').toContain('Review the release proposal');
    expect.soft(received?.textContent ?? '').toMatch(/\b(?:13|1):24\b/);
    expect.soft(received?.textContent ?? '').not.toContain('Approve deployment');
    expect.soft(entryAccessibleText(received ?? pane)).toContain('Review the release proposal');
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/needs? (?:a )?human/i);
    expect(pane.textContent).toContain('Approve deployment');
  } finally { component.dispose(); }
});

it('carries the timeline through the public snapshot projection without replacing live status', () => {
  const terminal = { ...statusTerminal({ attention: null }), timeline: [notification] };
  const card = directoryCards([terminal])[0];
  expect.soft(card).toMatchObject({ kind: 'single', timeline: [notification], work: terminal.work });
  expect.soft(card).not.toHaveProperty('notifications');
});

it('isolates the projected timeline from later changes to the snapshot it came from', () => {
  const terminal = { ...statusTerminal({ attention: null }), timeline: [structuredClone(notification)] };
  const card = directoryCards([terminal])[0];
  const held = terminal.timeline[0];
  if (held.kind === 'notification') held.message = 'changed afterwards';
  expect(card).toMatchObject({ timeline: [{ message: 'Review the release proposal' }] });
});
