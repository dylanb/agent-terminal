// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '../../src/shared/ipc';
import { createDisplaySettings } from '../../src/renderer/src/displaySettings';
import { showTokenCountsIn, showTokenCountsOn } from '../helpers/tokenCountsUi';

afterEach(() => document.body.replaceChildren());

function mount(read: () => Promise<UiSettings>) {
  const host = document.createElement('div');
  document.body.append(host);
  const sent: Partial<UiSettings>[] = [];
  const view = createDisplaySettings(host, { settings: { getSettings: read, setSettings: (patch) => { sent.push(patch); } } });
  return { host, sent, view };
}

const stored = (showTokenCounts: boolean) => () => Promise.resolve({ ...DEFAULT_UI_SETTINGS, showTokenCounts });

it.each([['on', true], ['off', false]] as const)('shows a "Show token counts" switch that reads %s when the saved setting is %s', async (_shown, saved) => {
  const { host } = mount(stored(saved));
  await vi.waitFor(() => showTokenCountsIn(host));
  expect(showTokenCountsOn(host)).toBe(saved);
});

it('reads off when the saved settings cannot be read', async () => {
  const { host } = mount(() => Promise.reject(new Error('main restarted')));
  await vi.waitFor(() => showTokenCountsIn(host));
  expect(showTokenCountsOn(host)).toBe(false);
});

it('saves the new value on each press and shows it', async () => {
  const { host, sent } = mount(stored(false));
  await vi.waitFor(() => showTokenCountsIn(host));
  showTokenCountsIn(host).click();
  const first = showTokenCountsOn(host);
  showTokenCountsIn(host).click();
  expect({ first, second: showTokenCountsOn(host), sent }).toEqual({
    first: true,
    second: false,
    sent: [{ showTokenCounts: true }, { showTokenCounts: false }],
  });
});

it('removes what it added when disposed', async () => {
  const { host, view } = mount(stored(true));
  await vi.waitFor(() => showTokenCountsIn(host));
  view.dispose();
  expect(host.childElementCount).toBe(0);
});
