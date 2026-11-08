// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createStatusStrip, type StatusStrip } from '../../src/renderer/src/statusStrip';
import type { MonitorUpdateMsg } from '../../src/shared/ipc';
import type { WaitingValue } from '../../src/shared/waiting';

const QUIET_SINCE = 1_000_000;
const NOW = QUIET_SINCE + 7_000;
const WAITING: WaitingValue = { program: 'MainThread', others: 1 };

const update = (waiting: WaitingValue | null): MonitorUpdateMsg => ({
  sessionId: 'main', altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince: QUIET_SINCE, waiting,
});

const strips: StatusStrip[] = [];
function mount(): { host: HTMLElement; strip: StatusStrip } {
  const host = document.createElement('div');
  document.body.append(host);
  const strip = createStatusStrip(host, () => NOW);
  strips.push(strip);
  strip.render();
  return { host, strip };
}
const agentChip = (host: HTMLElement): string | null =>
  [...host.children].map(chip => chip.textContent ?? '').find(text => text.startsWith('agent:')) ?? null;

afterEach(() => {
  for (const strip of strips.splice(0)) strip.dispose();
  document.body.innerHTML = '';
});

describe('the status strip while Waiting (#319 AC11)', () => {
  it('reads Waiting with the label in its own case when the first update is already Waiting', () => {
    const { host, strip } = mount();
    strip.update(update(WAITING));
    expect(agentChip(host)).toMatch(/\b(?:waiting|Waiting|WAITING)\b.*\bMainThread \+1\b/);
  });

  it('reads Waiting when an update brings it, then shows the quiet display it showed before #319 once Waiting ends', () => {
    const { host, strip } = mount();
    strip.update(update(null));
    strip.update(update(WAITING));
    const whileWaiting = agentChip(host);
    strip.update(update(null));
    const afterWaiting = agentChip(host);

    const neverWaiting = mount();
    neverWaiting.strip.update(update(null));
    expect({ whileWaiting, afterWaiting }).toEqual({
      whileWaiting: expect.stringMatching(/\b(?:waiting|Waiting|WAITING)\b.*\bMainThread \+1\b/),
      afterWaiting: agentChip(neverWaiting.host),
    });
  });
});
