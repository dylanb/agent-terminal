import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerApi, ControllerTerminal } from '../../src/shared/ipc';
import { compositeOver, contrastRatio, parseColor, ringOver, type RGBA } from '../helpers/wcag';

function background(element: Element): RGBA {
  const layers: RGBA[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = parseColor(getComputedStyle(current).backgroundColor);
    layers.push(color);
    if (color[3] === 1) break;
  }
  if (layers.at(-1)?.[3] !== 1) throw new Error('Contrast probe requires an opaque backdrop');
  return layers.reduceRight((behind, color) => compositeOver(color, behind));
}

function opacity(element: Element): number {
  let alpha = 1;
  for (let current: Element | null = element; current; current = current.parentElement) alpha *= Number(getComputedStyle(current).opacity);
  return alpha;
}

const terminals: ControllerTerminal[] = [
  { id: 'a', launchDirectory: '/left/project/a-long-launch-directory', repositoryRoot: '/left/project' },
  { id: 'b', launchDirectory: '/right/project/another-long-launch-directory', repositoryRoot: '/right/project' },
];

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe.each(['light', 'dark'])('controller panes in %s theme', theme => {
  function mount(items: ControllerTerminal[] = terminals) {
    document.documentElement.setAttribute('data-theme', theme);
    const host = document.createElement('main');
    document.body.append(host);
    const activated: string[] = [];
    const controller: ControllerApi = {
      subscribeTerminals(listener) { listener(items); return () => {}; },
      async activateTerminal(id) { activated.push(id); return 'activated'; },
    };
    return { host, activated, component: createControllerPanes(host, { controller }) };
  }

  it.each([320, 900])('paints a readable error state distinct from a live pane in a %ipx host', width => {
    const disconnected = { ...terminals[0], status: 'disconnected' as const };
    const { host, component } = mount([disconnected, terminals[1]]);
    host.style.width = `${width}px`;
    try {
      const labels = [...host.querySelectorAll<HTMLElement>('*')].filter(element =>
        element.childElementCount === 0 && element.textContent?.includes(disconnected.launchDirectory));
      const label = labels[0] ?? host;
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger)';
      host.append(probe);
      expect.soft(getComputedStyle(label).color).toBe(getComputedStyle(probe).color);
      expect.soft(host.textContent).toMatch(/disconnected/i);
      const behind = background(label);
      expect.soft(contrastRatio(ringOver(getComputedStyle(label).color, opacity(label), behind), behind)).toBeGreaterThanOrEqual(4.5);
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
      probe.remove();
    } finally { component.dispose(); }
  });

  it('reflows the activation controls as the host narrows', () => {
    const { host, component } = mount();
    try {
      const rowCount = () => new Set([...host.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size;
      host.style.width = '900px';
      const wideRows = rowCount();
      host.style.width = '320px';
      const narrowRows = rowCount();
      expect.soft(narrowRows).toBeGreaterThan(wideRows);
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    } finally { component.dispose(); }
  });

  it('activates a terminal through native keyboard interaction', async () => {
    const { activated, component } = mount();
    try {
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
      expect(activated).toEqual(['a']);
    } finally { component.dispose(); }
  });

  it.each([320, 900])('keeps identities painted and controls separated in a %ipx host', width => {
    const { host, component } = mount();
    host.style.width = `${width}px`;
    try {
      const hostBox = host.getBoundingClientRect();
      const readable = (text: string) => {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(text) ?? -1;
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + text.length);
          const boxes = [...range.getClientRects()];
          return boxes.length > 0 && boxes.every(box => box.width > 0 && box.height > 0
            && box.left >= hostBox.left && box.right <= hostBox.right
            && box.top >= hostBox.top && box.bottom <= hostBox.bottom
            && [...ancestors(node.parentElement!)].every(parent => {
              const style = getComputedStyle(parent);
              const clip = parent.getBoundingClientRect();
              return style.visibility === 'visible' && Number(style.opacity) > 0
                && (style.overflowX === 'visible' || (box.left >= clip.left && box.right <= clip.right))
                && (style.overflowY === 'visible' || (box.top >= clip.top && box.bottom <= clip.bottom));
            }));
        }
        return false;
      };
      for (const terminal of terminals) expect.soft(readable(terminal.launchDirectory)).toBe(true);
      const buttons = [...host.querySelectorAll('button')];
      expect.soft(buttons).toHaveLength(2);
      for (const [index, button] of buttons.entries()) {
        const box = button.getBoundingClientRect();
        expect.soft(box.width > 0 && box.height > 0 && box.left >= hostBox.left && box.right <= hostBox.right).toBe(true);
        for (const other of buttons.slice(index + 1)) {
          const next = other.getBoundingClientRect();
          expect.soft(box.right <= next.left || next.right <= box.left || box.bottom <= next.top || next.bottom <= box.top).toBe(true);
        }
      }
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    } finally { component.dispose(); }
  });

  it('keeps rendered labels above minimum text contrast', () => {
    const { host, component } = mount();
    try {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const element = node.parentElement!;
        const behind = background(element);
        const foreground = ringOver(getComputedStyle(element).color, opacity(element), behind);
        expect.soft(contrastRatio(foreground, behind)).toBeGreaterThanOrEqual(4.5);
      }
    } finally { component.dispose(); }
  });

  it('paints a visible keyboard focus ring on each activation control', async () => {
    const { host, component } = mount();
    try {
      for (const button of host.querySelectorAll('button')) {
        await userEvent.tab();
        expect.soft(document.activeElement).toBe(button);
        const style = getComputedStyle(button);
        const behind = background(button.parentElement!);
        expect.soft(style.outlineStyle).not.toBe('none');
        expect.soft(Number.parseFloat(style.outlineWidth)).toBeGreaterThan(0);
        expect.soft(contrastRatio(ringOver(style.outlineColor, opacity(button), behind), behind)).toBeGreaterThanOrEqual(3);
      }
    } finally { component.dispose(); }
  });
});

function* ancestors(element: Element): Generator<Element> {
  for (let current: Element | null = element; current; current = current.parentElement) yield current;
}
