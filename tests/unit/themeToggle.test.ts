// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createThemeToggle } from '../../src/renderer/src/themeToggle';
import type { Theme } from '../../src/shared/ipc';
import { darkThemeIn, darkThemeOn } from '../helpers/controllerCards';

afterEach(() => document.body.replaceChildren());

function mount(theme: Theme) {
  const host = document.createElement('header');
  document.body.append(host);
  const reported: Theme[] = [];
  const toggle = createThemeToggle(host, { theme, onChange: next => { reported.push(next); } });
  const state = () => (darkThemeIn(host) ? (darkThemeOn(host) ? 'on' : 'off') : 'missing');
  return { host, reported, state, toggle };
}

it.each([['light', 'off'], ['dark', 'on']] as const)('shows the Dark theme control %s as %s', (theme, shown) => {
  const { state } = mount(theme);
  expect(state()).toBe(shown);
});

it('flips the control and reports the new theme on each use', () => {
  const { host, reported, state } = mount('light');
  darkThemeIn(host)?.click();
  const first = state();
  darkThemeIn(host)?.click();
  expect({ first, second: state(), reported }).toEqual({ first: 'on', second: 'off', reported: ['dark', 'light'] });
});

it('removes its control when disposed', () => {
  const { host, state, toggle } = mount('dark');
  const shown = state();
  toggle.dispose();
  expect({ shown, disposed: host.childElementCount }).toEqual({ shown: 'on', disposed: 0 });
});
