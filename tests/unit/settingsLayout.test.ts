// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../src/renderer/src/styles.css'), 'utf8');

function overflowOf(selector: string): string {
  const m = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule ${selector} not found`);
  const o = m[1].match(/(?:^|;)\s*overflow(?:-y)?\s*:\s*([^;]+)/);
  return o ? o[1].trim() : '';
}

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

  it('makes that shared column the scroll container so the CLI affordance is reachable below the fold', () => {
    const column = kb.parentElement as HTMLElement;
    expect(/auto|scroll/.test(overflowOf(`#${column.id}`))).toBe(true);
  });
});
