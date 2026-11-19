import { randomUUID } from 'node:crypto';
import type { McpTmux } from '../shared/mcpBridge';
import { runTmux } from './mcpTmuxCommand';

export function createPaneTransport(tmux: McpTmux, pane: string): { paste(text: string): void; write(text: string): void } {
  const transfer = (data: string, paste: boolean): void => {
    if (!/^%\d+$/.test(pane)) throw new Error('the destination pane is invalid.');
    const buffer = `agent-terminal-${randomUUID()}`;
    try {
      runTmux(tmux, [
        'load-buffer', '-b', buffer, '-', ';',
        'paste-buffer', '-d', '-r', ...(paste ? ['-p'] : []), '-b', buffer, '-t', pane,
      ], data);
    } catch (error) {
      try { runTmux(tmux, ['delete-buffer', '-b', buffer]); } catch {}
      throw error;
    }
  };
  return { paste: data => transfer(data, true), write: data => transfer(data, false) };
}
