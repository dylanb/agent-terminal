import { afterEach, expect, it } from 'vitest';
import { renderMarkdownInto } from '../../src/renderer/src/viewerRender';

const hosts: HTMLElement[] = [];
afterEach(() => hosts.splice(0).forEach(host => host.remove()));

function render(source: string): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  renderMarkdownInto(source, host);
  return host;
}

it('renders artifact diagrams with mathematical labels', async () => {
  const host = render('```mermaid\nflowchart LR\n  A["$$x^2$$"] --> B["Result"]\n```');
  await expect.poll(() => host.querySelector('svg'), { timeout: 15000 }).not.toBeNull();
  expect(host.querySelector('svg math msup mi')?.textContent).toBe('x');
  expect(host.querySelector('svg math msup mn')?.textContent).toBe('2');
  expect(host.querySelector('svg')?.textContent).toContain('Result');
});

it('renders ordinary links while leaving executable links and raw HTML inert', async () => {
  const host = render('[reference](https://example.com/docs)\n\n[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
  await expect.poll(() => host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
  expect([...host.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['https://example.com/docs']);
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
});
