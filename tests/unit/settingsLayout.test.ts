// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The scroll-container behavior (the CLI affordance reachable below the fold) is proven by the real-layout
// e2e in tests/e2e/app.spec.ts (§23.5); jsdom computes no cascade, so this unit layer asserts only the
// observable DOM structure the two sections share, never the stylesheet's authoring form.
const html = readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

describe('Settings viewpane layout reachability (§23.5)', () => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pane = doc.querySelector('[data-viewpane="4"]') as HTMLElement;
  const kb = doc.querySelector('#kb-settings-view') as HTMLElement;
  const cli = doc.querySelector('#cli-install-view') as HTMLElement;

  it('mounts the keyboard and CLI-install sections in one shared scroll column, not the non-scrolling pane', () => {
    expect(pane).toBeTruthy();
    expect(kb).toBeTruthy();
    expect(cli).toBeTruthy();
    expect(kb.parentElement).toBe(cli.parentElement);
    const column = kb.parentElement as HTMLElement;
    expect(column).not.toBe(pane);
    expect(pane.contains(column)).toBe(true);
    expect(column.id).toBeTruthy();
  });
});
