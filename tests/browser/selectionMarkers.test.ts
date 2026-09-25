import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Terminal } from '@xterm/xterm';
import { wireSelection } from '../../src/renderer/src/selection';
import { resolveKeymap } from '../../src/shared/keymap';
import {
  CAPTURE_RANGE_ADD_EVENT,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
} from '../../src/renderer/src/paneActions';

// Every marker the renderer registers subscribes to the buffer's trim/insert/delete events, so a
// marker that is never disposed taxes every subsequent line of output until it trims out of
// scrollback — a long-running noisy agent (Codex) turns that into a renderer that pegs the CPU.

const write = (term: Terminal, data: string): Promise<void> => new Promise((r) => term.write(data, r));

describe('terminal selection + §16.8 reveal: native highlight, no leaked markers', () => {
  let host: HTMLElement;
  let term: Terminal;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '640px';
    host.style.height = '240px';
    document.body.appendChild(host);
    term = new Terminal({ cols: 80, rows: 10, scrollback: 5000, allowProposedApi: true });
    term.open(host);
    wireSelection(term, () => resolveKeymap('pc'));
  });

  afterEach(() => {
    vi.useRealTimers();
    term.dispose();
    host.remove();
  });

  it('scrolling output under an active selection registers no markers', async () => {
    await write(term, Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\r\n'));
    term.select(0, 12, 40);
    expect(term.getSelection()).not.toBe('');

    for (let i = 0; i < 200; i++) await write(term, `\r\nmore-${i}`);

    expect(term.markers.length).toBe(0);
  });

  describe('Escape follows the visible native selection (§7.5.1)', () => {
    const escapesSent = (sent: string[]): number => sent.filter((d) => d === '\x1b').length;
    let sent: string[];

    beforeEach(async () => {
      sent = [];
      term.onData((d) => sent.push(d));
      await write(term, 'alpha beta gamma');
      term.focus();
    });

    it('is consumed to clear an active selection', async () => {
      term.select(0, 0, 5);
      await userEvent.keyboard('{Escape}');
      expect(escapesSent(sent)).toBe(0);
      expect(term.hasSelection()).toBe(false);
    });

    it('reaches the agent once typing has cleared the selection', async () => {
      term.select(0, 0, 5);
      await userEvent.keyboard('x');
      expect(term.hasSelection()).toBe(false);
      await userEvent.keyboard('{Escape}');
      expect(escapesSent(sent)).toBe(1);
    });
  });

  it('a capture reveal releases every marker it drew once the highlight clears', async () => {
    await write(term, Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\r\n'));
    window.dispatchEvent(
      new CustomEvent(CAPTURE_RANGE_ADD_EVENT, {
        detail: { id: 'cap-1', range: { start: { x: 0, y: 5 }, end: { x: 5, y: 9 } } },
      }),
    );
    const anchored = term.markers.length;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.dispatchEvent(new CustomEvent(REVEAL_TERMINAL_EVENT, { detail: { id: 'cap-1' } }));
    expect(term.markers.length).toBeGreaterThan(anchored);
    vi.advanceTimersByTime(REVEAL_HIGHLIGHT_MS);

    expect(term.markers.length).toBe(anchored);
  });
});
