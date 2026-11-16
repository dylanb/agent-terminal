// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createTokenCount, type TokenCountValue } from '../../src/renderer/src/tokenCount';
import { accessibleTextOf } from '../helpers/tokenCountsUi';

afterEach(() => document.body.replaceChildren());

function mount(value: TokenCountValue) {
  const host = document.createElement('div');
  document.body.append(host);
  const count = createTokenCount(host);
  count.set(value);
  const text = (): string => (host.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { host, count, text };
}

it('shows a dash for a step not entered', () => {
  expect(mount({ shown: 'dash' }).text()).toBe('—');
});

it('shows a count as given', () => {
  expect(mount({ shown: 'count', text: '12.3k', counting: false }).text()).toBe('12.3k');
});

it('marks a count counting in its visible and accessible text, after the count', () => {
  expect(mount({ shown: 'count', text: '4.5M', counting: true }).text()).toBe('4.5M counting');
});

it('marks a partly reported count after the count and before the counting mark, in its visible and accessible text', () => {
  const { host, text } = mount({ shown: 'count', text: '8.6k', counting: true, partly: true });
  expect({ visible: text(), accessible: accessibleTextOf(host.firstElementChild!) }).toEqual({
    visible: '8.6k partly reported counting',
    accessible: '8.6k partly reported counting',
  });
});

it('shows not reported in place of a figure, in its visible and accessible text', () => {
  const still = mount({ shown: 'not reported', counting: true });
  const closed = mount({ shown: 'not reported', counting: false });
  expect([still.text(), accessibleTextOf(still.host.firstElementChild!), closed.text()]).toEqual(['not reported counting', 'not reported counting', 'not reported']);
});

it('shows unavailable in place of a figure, counting while its window is open, in its visible and accessible text', () => {
  const still = mount({ shown: 'unavailable', counting: true });
  const closed = mount({ shown: 'unavailable', counting: false });
  expect([still.text(), accessibleTextOf(still.host.firstElementChild!), closed.text()]).toEqual(['unavailable counting', 'unavailable counting', 'unavailable']);
});

it('marks an incomplete count after its figure and partly reported marker, in its visible and accessible text', () => {
  const both = mount({ shown: 'count', text: '29.6k', counting: false, partly: true, incomplete: true });
  const incomplete = mount({ shown: 'count', text: '12.5k', counting: false, incomplete: true });
  expect([both.text(), accessibleTextOf(both.host.firstElementChild!), incomplete.text()]).toEqual([
    '29.6k partly reported incomplete',
    '29.6k partly reported incomplete',
    '12.5k incomplete',
  ]);
});

it('marks a not reported cell incomplete, in its visible and accessible text', () => {
  const { host, text } = mount({ shown: 'not reported', counting: false, incomplete: true });
  expect([text(), accessibleTextOf(host.firstElementChild!)]).toEqual(['not reported incomplete', 'not reported incomplete']);
});

it('shows each new value in place of the last', () => {
  const { count, text } = mount({ shown: 'count', text: '812.3k', counting: true });
  count.set({ shown: 'count', text: '900.1k', counting: false });
  const later = text();
  count.set({ shown: 'dash' });
  expect({ later, last: text() }).toEqual({ later: '900.1k', last: '—' });
});

it('is never announced: it sits outside any announcing live region however its host announces', () => {
  const { host } = mount({ shown: 'count', text: '7', counting: true });
  host.setAttribute('aria-live', 'polite');
  const inner = host.firstElementChild;
  expect(inner?.closest('[aria-live]')?.getAttribute('aria-live')).toBe('off');
});

it('removes what it rendered when disposed', () => {
  const { host, count } = mount({ shown: 'count', text: '7', counting: false });
  count.dispose();
  expect(host.childElementCount).toBe(0);
});
