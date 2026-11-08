// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSortModeControl } from '../../src/renderer/src/sortModeControl';
import type { ControllerSortMode } from '../../src/shared/ipc';
import { SORT_OPTIONS, controlName, selectedSortOptionsIn, sortControlIn, sortOptionIn, type SortOption } from '../helpers/controllerCards';
import type { SortMode } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const OPTION_OF: Readonly<Record<SortMode, SortOption>> = { attention: 'Attention', 'recently-used': 'Recently used' };

function mount(mode: ControllerSortMode, onChange: (mode: ControllerSortMode) => void | Promise<unknown> = () => {}) {
  const host = document.createElement('header');
  document.body.append(host);
  const reported: ControllerSortMode[] = [];
  const control = createSortModeControl(host, { mode, onChange: next => { reported.push(next); return onChange(next); } });
  const option = (name: SortOption): HTMLElement => {
    const found = sortOptionIn(host, name);
    if (!found) throw new Error(`No ${name} sort option`);
    return found;
  };
  const press = (name: SortOption, key: string) =>
    option(name).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { host, reported, control, option, press };
}

/** The options a Tab press can land on: an option is in the tab sequence when its tab index is not negative. */
const tabStops = (host: HTMLElement): string[] =>
  SORT_OPTIONS.filter(name => (sortOptionIn(host, name)?.tabIndex ?? -1) >= 0);

describe('the sort control', () => {
  it.each(Object.entries(OPTION_OF) as [SortMode, SortOption][])('when created in %s order, is a group named Sort cards of the two options, %s alone selected', (mode, shown) => {
    const { host } = mount(mode);
    expect({
      group: controlName(sortControlIn(host)).trim(),
      options: SORT_OPTIONS.map(name => controlName(sortOptionIn(host, name)).trim()),
      selected: selectedSortOptionsIn(host),
    }).toEqual({ group: 'Sort cards', options: ['Attention', 'Recently used'], selected: [shown] });
  });

  it.each(Object.entries(OPTION_OF) as [SortMode, SortOption][])('in %s order, puts only the selected option, %s, in the tab sequence', (mode, shown) => {
    const { host } = mount(mode);
    expect(tabStops(host)).toEqual([shown]);
  });

  it('selects a pressed option and reports its order, each time the selection changes', () => {
    const { host, reported, option } = mount('attention');
    option('Recently used').click();
    const first = { selected: selectedSortOptionsIn(host), tabStops: tabStops(host) };
    option('Attention').click();
    expect({ first, second: { selected: selectedSortOptionsIn(host), tabStops: tabStops(host) }, reported }).toEqual({
      first: { selected: ['Recently used'], tabStops: ['Recently used'] },
      second: { selected: ['Attention'], tabStops: ['Attention'] },
      reported: ['recently-used', 'attention'],
    });
  });

  it.each([
    ['ArrowRight', 'attention', 'Recently used', 'recently-used'],
    ['ArrowDown', 'attention', 'Recently used', 'recently-used'],
    ['ArrowLeft', 'recently-used', 'Attention', 'attention'],
    ['ArrowUp', 'recently-used', 'Attention', 'attention'],
    ['ArrowRight', 'recently-used', 'Attention', 'attention'],
    ['ArrowLeft', 'attention', 'Recently used', 'recently-used'],
  ] as const)('%s from the selected option in %s order moves focus to %s, selects it and reports its order', (key, mode, next, order) => {
    const { host, reported, option, press } = mount(mode);
    option(OPTION_OF[mode]).focus();
    press(OPTION_OF[mode], key);
    expect({ focused: controlName(document.activeElement).trim(), selected: selectedSortOptionsIn(host), reported })
      .toEqual({ focused: next, selected: [next], reported: [order] });
  });

  it('while the order a press reported is still being acted on, changes the selection for neither a press nor an arrow key, then accepts the next press once it settles', async () => {
    let settle!: () => void;
    const pending = new Promise<void>(done => { settle = done; });
    const { host, reported, option, press } = mount('attention', next => (next === 'recently-used' ? pending : undefined));
    option('Recently used').click();
    option('Attention').click();
    option('Recently used').focus();
    press('Recently used', 'ArrowLeft');
    const whilePending = { selected: selectedSortOptionsIn(host), reported: [...reported] };
    settle();
    // A press the control ignores while busy reports nothing, so pressing until one is accepted reports it once.
    await vi.waitFor(() => {
      option('Attention').click();
      expect(selectedSortOptionsIn(host)).toEqual(['Attention']);
    }).catch(() => undefined);
    expect({ whilePending, settled: { selected: selectedSortOptionsIn(host), reported } }).toEqual({
      whilePending: { selected: ['Recently used'], reported: ['recently-used'] },
      settled: { selected: ['Attention'], reported: ['recently-used', 'attention'] },
    });
  });

  it('removes its control when disposed', () => {
    const { host, control } = mount('attention');
    expect.soft(sortControlIn(host), 'the control is shown while mounted').toBeDefined();
    control.dispose();
    expect(host.childElementCount).toBe(0);
  });
});
