// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { directoryCards, type ControllerDirectoryCard } from '../../src/shared/controllerCards';
import { cardIn, receivedNotificationIn, statusRowIn } from '../helpers/controllerCards';
import { statusTerminal } from '../helpers/controllerStatusFixture';

const receivedAt = new Date(2026, 9, 28, 13, 24, 56).getTime();
const latestNotification = { message: 'Review the release proposal', receivedAt };

afterEach(() => document.body.replaceChildren());

it('shows a received message and receipt time separately from the current human-needed reason', () => {
  const terminal = statusTerminal({ attention: { status: 'complete', reasons: ['Approve deployment'] } });
  const card: ControllerDirectoryCard & { latestNotification: typeof latestNotification } = {
    ...directoryCards([terminal])[0], latestNotification,
  };
  const host = document.createElement('main');
  document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onAction() {} });
  try {
    const pane = cardIn(host, terminal.launchDirectory)!;
    const received = receivedNotificationIn(pane);
    expect.soft(received?.textContent ?? '').toContain(latestNotification.message);
    expect.soft(received?.textContent ?? '').toMatch(/\b(?:13|1):24\b/);
    expect.soft(received?.textContent ?? '').not.toContain('Approve deployment');
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/needs? (?:a )?human/i);
    expect(pane.textContent).toContain('Approve deployment');
  } finally { component.dispose(); }
});

it('carries the received notification through the public snapshot projection without replacing live status', () => {
  const terminal = { ...statusTerminal({ attention: null }), latestNotification };
  expect(directoryCards([terminal])[0]).toMatchObject({ kind: 'single', latestNotification, work: terminal.work });
});
