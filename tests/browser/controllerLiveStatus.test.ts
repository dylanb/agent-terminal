import { afterEach, describe, expect, it, vi } from 'vitest';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { bringForwardIn, cardIn, showFullReasonIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';
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
    const parent = document.createElement('div');
    parent.style.width = `${width}px`;
    document.body.append(parent);
    const terminal = statusTerminal({
      flow: { availability: 'known', name: 'delivery', step: 'review', assignment: 'completed' }, activity: 'quiet',
      attention: { status: 'complete', reasons: ['Approval requires your decision'] },
      error: { reason: 'Required verification failed' },
    });
    const { host, dispose } = mountControllerPanes({ terminals: [terminal], parent });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      for (const text of ['Flow error', 'Idle', 'Human needed: complete', 'Approval requires your decision', 'Error', 'Required verification failed']) {
        const label = card ? textElements(card, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))[0] : undefined;
        const behind = label ? backdrop(label) : undefined;
        expect.soft(Boolean(label && painted(label) && behind && contrastRatio(ringOver(getComputedStyle(label).color, opacity(label), behind), behind) >= 4.5), `readable ${text}`).toBe(true);
      }
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    } finally { dispose(); }
  });

  it('ellipsizes a long title while keeping the issue number and full reasons accessible', async () => {
    document.documentElement.dataset.theme = theme;
    const parent = document.createElement('aside');
    parent.style.width = '320px';
    document.body.append(parent);
    const title = 'A long issue title '.repeat(30);
    const reason = 'The full failure reason must remain accessible. '.repeat(80);
    const terminal = statusTerminal({
      ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } },
      attention: { status: 'complete', reasons: [reason] },
    });
    terminal.launchDirectory = '/work/' + 'long-worktree-'.repeat(25);
    const { host, dispose } = mountControllerPanes({ terminals: [terminal], parent });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      const preview = card ? textElements(card, /A long issue title/)[0] : undefined;
      const style = preview ? getComputedStyle(preview) : undefined;
      expect.soft(Boolean(preview && style && painted(preview) && style.textOverflow === 'ellipsis' && ['hidden', 'clip'].includes(style.overflowX) && style.whiteSpace === 'nowrap' && preview.scrollWidth > preview.clientWidth), 'single-line visible ellipsis').toBe(true);
      expect.soft(card ? visibleText(card, '#219') : false, 'readable issue number').toBe(true);
      expect.soft(card?.textContent ?? '', 'full reason available to assistive technology').toContain(reason);
      const fullReason = () => {
        const reasonLabel = textElements(host, /The full failure reason/)[0];
        return Boolean(reasonLabel && visibleText(host, reason, true) && !reasonLabel.closest('[aria-hidden="true"], [hidden]'));
      };
      (await vi.waitFor(() => { const control = card ? showFullReasonIn(card) : undefined; if (!control) throw new Error('no control yet'); return control; }).catch(() => undefined))?.click();
      const readable = await vi.waitFor(() => { if (!fullReason()) throw new Error('not shown yet'); return true; }).catch(() => false);
      expect.soft(readable, 'full reason is visibly readable once Show full reason is used').toBe(true);
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
      const bringForward = card ? bringForwardIn(card) : undefined;
      expect.soft(painted(bringForward), 'Bring forward remains reachable').toBe(true);
    } finally { dispose(); }
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
