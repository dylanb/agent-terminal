// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Theme } from '../../src/shared/ipc';
import { themeControlIn, darkThemeOn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService } from '../helpers/controllerStatusFixture';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('neither paints nor shows a Dark theme control when the saved theme loads after disposal', async () => {
  let load!: (theme: Theme) => void;
  const saved = new Promise<Theme>(done => { load = done; });
  const { host, applied, dispose } = mountControllerPanes({ controller: { ...statusService().api, getTheme: () => saved } });
  dispose();
  load('dark');
  await new Promise(settled => setTimeout(settled));
  expect({ applied, control: Boolean(themeControlIn(document.body) ?? themeControlIn(host)) }).toEqual({ applied: [], control: false });
});

it('keeps the chosen theme and logs the failure when saving it fails', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { host, applied, dispose } = mountControllerPanes({
    controller: { ...statusService().api, setTheme: async () => { throw new Error('save failed'); } },
  });
  try {
    await vi.waitFor(() => { if (!themeControlIn(host)) throw new Error('no Dark theme control yet'); });
    themeControlIn(host)?.click();
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect({ applied: applied.at(-1), on: darkThemeOn(host) }).toEqual({ applied: 'dark', on: true });
  } finally { dispose(); }
});
