// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createThemeToggle } from '../../src/renderer/src/themeToggle';
import type { Theme } from '../../src/shared/ipc';
import { themeControlIn, darkThemeOn } from '../helpers/controllerCards';

afterEach(() => document.body.replaceChildren());

function mount(theme: Theme) {
  const host = document.createElement('header');
  document.body.append(host);
  const reported: Theme[] = [];
  const toggle = createThemeToggle(host, { theme, onChange: next => { reported.push(next); } });
  const state = () => (themeControlIn(host) ? (darkThemeOn(host) ? 'on' : 'off') : 'missing');
  return { host, reported, state, toggle };
}

it.each([['light', 'Dark theme'], ['dark', 'Light theme']] as const)('in the %s theme, names the control %s, the theme it switches to', (theme, name) => {
  const { host } = mount(theme);
  const control = themeControlIn(host);
  expect({ name: control?.textContent, pressed: control?.hasAttribute('aria-pressed') }).toEqual({ name, pressed: false });
});

it('flips the control and reports the new theme on each use', () => {
  const { host, reported, state } = mount('light');
  themeControlIn(host)?.click();
  const first = state();
  themeControlIn(host)?.click();
  expect({ first, second: state(), reported }).toEqual({ first: 'on', second: 'off', reported: ['dark', 'light'] });
});

it('removes its control when disposed', () => {
  const { host, state, toggle } = mount('dark');
  const shown = state();
  toggle.dispose();
  expect({ shown, disposed: host.childElementCount }).toEqual({ shown: 'on', disposed: 0 });
});
