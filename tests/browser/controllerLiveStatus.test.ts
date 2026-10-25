import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';
import { compositeOver, contrastRatio, parseColor, ringOver, type RGBA } from '../helpers/wcag';

function backdrop(element: Element): RGBA {
  const layers: RGBA[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor);
    layers.push(color);
    if (color[3] === 1) break;
  }
  return layers.reduceRight((behind, color) => compositeOver(color, behind), [255, 255, 255, 1] as RGBA);
}

function textElements(host: HTMLElement, pattern: RegExp): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('*')].filter(element => pattern.test(element.textContent ?? '') &&
    ![...element.children].some(child => pattern.test(child.textContent ?? '')));
}

function opacity(element: Element): number {
  let alpha = 1;
  for (let node: Element | null = element; node; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity);
  return alpha;
}

function painted(element: HTMLElement | undefined): boolean {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === 'visible' && opacity(element) > 0;
}

function visibleText(host: HTMLElement, text: string, allowScroll = false): boolean {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0 || !painted(node.parentElement ?? undefined)) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const boxes = [...range.getClientRects()];
    return boxes.length > 0 && boxes.every(box => {
      if (box.width <= 0 || box.height <= 0) return false;
      for (let parent: HTMLElement | null = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if ((parent === host || (allowScroll ? ['hidden', 'clip'].includes(style.overflowX) : style.overflowX !== 'visible')) && (box.left < bounds.left || box.right > bounds.right)) return false;
        if ((allowScroll ? ['hidden', 'clip'].includes(style.overflowY) : style.overflowY !== 'visible') && (box.top < bounds.top || box.bottom > bounds.bottom)) return false;
      }
      return true;
    });
  }
  return false;
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe.each(['light', 'dark'])('live status painted in %s theme', theme => {
  it.each([320, 900])('keeps all independent status dimensions readable at %ipx', width => {
    document.documentElement.dataset.theme = theme;
    const host = document.createElement('main');
    host.style.width = `${width}px`;
    document.body.append(host);
    const terminal = statusTerminal({
      flow: { availability: 'known', name: 'delivery', step: 'review', assignment: 'completed' }, activity: 'quiet',
      attention: { status: 'complete', reasons: ['Approval requires your decision'] },
      error: { reason: 'Required verification failed' },
    });
    const component = createControllerPanes(host, { controller: statusService([terminal]).api });
    try {
      for (const [pattern, color] of [[/completed/i, '--pass-text'], [/idle|quiet/i, '--dim'], [/needs? (?:a )?human|human.*needed/i, '--attn-text'], [/error/i, '--danger']] as const) {
        const label = textElements(host, pattern)[0];
        expect.soft(painted(label), `painted ${pattern}`).toBe(true);
        const token = document.createElement('span');
        token.style.color = `var(${color})`;
        host.append(token);
        expect.soft(label ? getComputedStyle(label).color : null, `themed ${pattern}`).toBe(getComputedStyle(token).color);
        token.remove();
        const behind = label ? backdrop(label) : undefined;
        expect.soft(Boolean(label && behind && contrastRatio(ringOver(getComputedStyle(label).color, opacity(label), behind), behind) >= 4.5), `contrast ${pattern}`).toBe(true);
      }
      const error = textElements(host, /Required verification failed/)[0];
      const token = document.createElement('span');
      token.style.color = 'var(--danger)';
      host.append(token);
      expect.soft(error ? getComputedStyle(error).color : null, 'error uses the themed danger color').toBe(getComputedStyle(token).color);
      token.remove();
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    } finally { component.dispose(); }
  });

  it('ellipsizes a long title while keeping the issue number and full reasons accessible', async () => {
    document.documentElement.dataset.theme = theme;
    const host = document.createElement('aside');
    host.style.width = '320px';
    document.body.append(host);
    const title = 'A long issue title '.repeat(30);
    const reason = 'The full failure reason must remain accessible. '.repeat(80);
    const terminal = statusTerminal({
      ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } },
      attention: { status: 'complete', reasons: [reason] },
    });
    terminal.launchDirectory = '/work/' + 'long-worktree-'.repeat(25);
    const component = createControllerPanes(host, { controller: statusService([terminal]).api });
    try {
      const preview = textElements(host, /A long issue title/)[0];
      const style = preview ? getComputedStyle(preview) : undefined;
      expect.soft(Boolean(preview && style && painted(preview) && style.textOverflow === 'ellipsis' && ['hidden', 'clip'].includes(style.overflowX) && style.whiteSpace === 'nowrap' && preview.scrollWidth > preview.clientWidth), 'single-line visible ellipsis').toBe(true);
      expect.soft(visibleText(host, '#219'), 'readable issue number').toBe(true);
      expect.soft(host.textContent, 'full reason available to assistive technology').toContain(reason);
      const reasonLabel = textElements(host, /The full failure reason/)[0];
      expect.soft(Boolean(reasonLabel && visibleText(host, reason, true) && !reasonLabel.closest('[aria-hidden="true"], [hidden]')), 'full reason is visibly readable without clipping').toBe(true);
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
      await userEvent.tab();
      const focused = document.activeElement as HTMLElement;
      expect.soft(host.contains(focused) && focused.tagName === 'BUTTON' && painted(focused), 'keyboard activation remains reachable').toBe(true);
    } finally { component.dispose(); }
  });
});

it('the reason visibility oracle rejects ancestor clipping but permits scrolling', () => {
  const host = document.createElement('main');
  host.className = 'controller-panes';
  host.style.cssText = 'width: 320px';
  const wrapper = document.createElement('div');
  const reason = document.createElement('span');
  const text = 'A complete readable reason. '.repeat(80);
  reason.textContent = text;
  wrapper.append(reason);
  host.append(wrapper);
  document.body.append(host);
  expect(visibleText(host, text, true)).toBe(true);
  wrapper.style.cssText = 'height: 20px; overflow: hidden';
  expect(visibleText(host, text, true)).toBe(false);
  wrapper.style.overflow = 'auto';
  expect(visibleText(host, text, true)).toBe(true);
});
