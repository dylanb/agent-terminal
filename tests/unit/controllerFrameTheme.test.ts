// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { applyDocumentTheme } from '../../src/renderer/src/controllerFrame';

afterEach(() => document.documentElement.setAttribute('data-theme', 'light'));

it('paints the document dark, then light again, as each theme is applied', () => {
  const root = document.documentElement;
  root.setAttribute('data-theme', 'light');
  applyDocumentTheme(root, 'dark');
  const dark = root.getAttribute('data-theme');
  applyDocumentTheme(root, 'light');
  expect({ dark, light: root.getAttribute('data-theme') }).toEqual({ dark: 'dark', light: 'light' });
});
