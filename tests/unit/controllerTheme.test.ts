// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../../src/shared/ipc';
import { themeControlIn, darkThemeOn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const themeControl = (host: HTMLElement) => (themeControlIn(host) ? (darkThemeOn(host) ? 'on' : 'off') : 'missing');

/** Waits for the Dark theme control to appear; a control that never appears is left for the caller's check. */
const shown = (host: HTMLElement) => vi.waitFor(() => {
  if (!themeControlIn(host)) throw new Error('no Dark theme control yet');
}).catch(() => undefined);

describe('the controller theme', () => {
  it.each(['light', 'dark'] as const)('applies the saved %s theme and shows it on the Dark theme control', async theme => {
    const { host, applied, dispose } = mountControllerPanes({ theme });
    try {
      await shown(host);
      expect({ applied: applied.at(-1), control: themeControl(host) }).toEqual({ applied: theme, control: theme === 'dark' ? 'on' : 'off' });
    } finally { dispose(); }
  });

  it('shows no Dark theme control until the saved theme has loaded', async () => {
    const service = statusService();
    let load!: (theme: Theme) => void;
    const saved = new Promise<Theme>(done => { load = done; });
    const { host, applied, dispose } = mountControllerPanes({ controller: { ...service.api, getTheme: () => saved } });
    try {
      const before = themeControl(host);
      load('dark');
      await shown(host);
      expect({ before, after: themeControl(host), applied: applied.at(-1) }).toEqual({ before: 'missing', after: 'on', applied: 'dark' });
    } finally { dispose(); }
  });

  it('applies and saves the new theme at once on each use of the Dark theme control', async () => {
    const { host, service, applied, dispose } = mountControllerPanes();
    try {
      await shown(host);
      const savedOnLoad = [...service.savedThemes];
      themeControlIn(host)?.click();
      const first = { applied: applied.at(-1), saved: [...service.savedThemes], control: themeControl(host) };
      themeControlIn(host)?.click();
      expect({ savedOnLoad, first, second: { applied: applied.at(-1), saved: service.savedThemes, control: themeControl(host) } }).toEqual({
        savedOnLoad: [],
        first: { applied: 'dark', saved: ['dark'], control: 'on' },
        second: { applied: 'light', saved: ['dark', 'light'], control: 'off' },
      });
    } finally { dispose(); }
  });

  it('stays light, with the Dark theme control off, when the saved theme cannot be read', async () => {
    const { host, applied, dispose } = mountControllerPanes({ theme: 'unreadable' });
    try {
      await shown(host);
      expect({ painted: applied.filter(theme => theme !== 'light'), control: themeControl(host) }).toEqual({ painted: [], control: 'off' });
    } finally { dispose(); }
  });

  it('keeps focus on the Dark theme control across a live snapshot', async () => {
    const { host, service, dispose } = mountControllerPanes();
    try {
      await shown(host);
      themeControlIn(host)?.focus();
      service.publish([statusTerminal({ activity: 'quiet' })]);
      const control = themeControlIn(host);
      expect(control !== undefined && document.activeElement === control).toBe(true);
    } finally { dispose(); }
  });
});
