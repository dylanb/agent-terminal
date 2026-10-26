// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createClampedReason } from '../../src/renderer/src/clampedReason';

afterEach(() => document.body.replaceChildren());

it('renders the reason as text, never as markup, and removes it on dispose', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const text = '<img src=x onerror=alert(1)>\nsecond line';
  const reason = createClampedReason(host, { text, full: false, onToggle() {} });
  const words = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, '');
  const shown = { text: words(host.textContent).includes(words(text)), markup: host.querySelector('img') !== null };
  reason.dispose();
  expect({ ...shown, afterDispose: host.textContent }).toEqual({ text: true, markup: false, afterDispose: '' });
});
