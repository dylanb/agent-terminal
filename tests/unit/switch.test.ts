// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createSwitch } from '../../src/renderer/src/switch';
import { alwaysOnTopIn, alwaysOnTopOn, controlName } from '../helpers/controllerCards';

afterEach(() => document.body.replaceChildren());

function mount(checked: boolean) {
  const host = document.createElement('header');
  document.body.append(host);
  const reported: boolean[] = [];
  const control = createSwitch(host, { label: 'Always on top', checked, onChange: next => { reported.push(next); } });
  const state = () => (alwaysOnTopIn(host) ? (alwaysOnTopOn(host) ? 'on' : 'off') : 'missing');
  return { host, reported, state, control };
}

it.each([[true, 'on'], [false, 'off']] as const)('when created %s, is a switch named by its label that reports itself %s', (checked, shown) => {
  const { host, state } = mount(checked);
  expect({ name: controlName(alwaysOnTopIn(host)).trim(), state: state() }).toEqual({ name: 'Always on top', state: shown });
});

it('flips and reports the new state on each use', () => {
  const { host, reported, state } = mount(true);
  alwaysOnTopIn(host)?.click();
  const first = state();
  alwaysOnTopIn(host)?.click();
  expect({ first, second: state(), reported }).toEqual({ first: 'off', second: 'on', reported: [false, true] });
});

it('shows a state set from outside without reporting it', () => {
  const { reported, state, control } = mount(true);
  control.set(false);
  const off = state();
  control.set(true);
  expect({ off, on: state(), reported }).toEqual({ off: 'off', on: 'on', reported: [] });
});

it('removes its control when disposed', () => {
  const { host, state, control } = mount(false);
  expect.soft(state()).toBe('off');
  control.dispose();
  expect(host.childElementCount).toBe(0);
});
