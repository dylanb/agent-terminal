import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTerminalPane, type TerminalPane } from '../../src/renderer/src/terminal';
import type { TermApi } from '../../src/shared/ipc';

const ptyOutput = (): { api: TermApi; emit: (data: string) => void } => {
  const listeners: Array<(data: string) => void> = [];
  const api = {
    onData: (cb: (data: string) => void) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    onExit: () => () => {},
    input: () => {},
    resize: () => {},
    pathForFile: () => '',
  } as unknown as TermApi;
  return { api, emit: (data) => listeners.forEach((cb) => cb(data)) };
};

const nextAnnouncement = (region: Element): Promise<void> =>
  new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      if (!region.textContent) return;
      obs.disconnect();
      setTimeout(resolve, 0);
    });
    obs.observe(region, { childList: true, characterData: true, subtree: true });
  });

describe('terminal screen-reader live region', () => {
  let host: HTMLElement;
  let pane: TerminalPane;
  let emit: (data: string) => void;
  let previousTerm: TermApi;

  beforeEach(() => {
    previousTerm = window.term;
    const pty = ptyOutput();
    window.term = pty.api;
    emit = pty.emit;
    host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '400px';
    document.body.appendChild(host);
    pane = createTerminalPane(host);
  });

  afterEach(() => {
    pane.dispose();
    host.remove();
    window.term = previousTerm;
  });

  it('holds at most 100 characters of a full-screen redraw that sends no line feeds', async () => {
    const region = host.querySelector('.live-region');
    expect(region).not.toBeNull();
    const announced = nextAnnouncement(region!);

    const frame = (n: number): string => `\x1b[H\x1b[2J${`frame ${n} `.repeat(8)}`;
    emit(Array.from({ length: 40 }, (_, n) => frame(n)).join(''));
    await announced;

    expect(region!.textContent!.length).toBeGreaterThan(0);
    expect(region!.textContent!.length).toBeLessThanOrEqual(100);
  });
});
