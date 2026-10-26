import { afterEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import startupHtml from '../../src/renderer/index.html?raw';
import { createCliInstallAction } from '../../src/renderer/src/cliInstallAction';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe.each(['light', 'dark'])('startup spacing in %s', theme => {
  it.each([320, 900])('follows theme spacing and fits a %ipx host', width => {
    document.documentElement.dataset.theme = theme;
    const template = new DOMParser().parseFromString(startupHtml, 'text/html');
    const waiting = template.getElementById('startup-waiting')!;
    document.body.append(waiting);
    createCliInstallAction(waiting.querySelector<HTMLElement>('#startup-cli-install')!, {
      install: async () => ({ ok: true, path: '/p/agent-terminal' }),
    });
    waiting.style.width = `${width}px`;
    waiting.style.setProperty('--r', '7px');
    const initialPadding = Number.parseFloat(getComputedStyle(waiting).paddingLeft);
    waiting.style.setProperty('--r', '11px');
    expect(Number.parseFloat(getComputedStyle(waiting).paddingLeft)).toBeGreaterThan(initialPadding);
    expect(waiting.scrollWidth).toBeLessThanOrEqual(waiting.clientWidth);
    expect(waiting.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(waiting.textContent).toContain('Start Agent Terminal Controller');
    const install = waiting.querySelector<HTMLElement>('button[aria-label="Install the agent-terminal command-line launcher"]')!;
    const card = waiting.querySelector<HTMLElement>('.startup-card')!.getBoundingClientRect();
    expect(install.getBoundingClientRect().right).toBeLessThanOrEqual(card.right);
  });
});
