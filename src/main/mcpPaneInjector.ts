import { randomUUID } from 'node:crypto';
import type { McpTmux } from '../shared/mcpBridge';
import type { Injector } from './inject';
import { runTmux } from './mcpTmuxCommand';
import { createRecipientInjector } from './recipientInjector';

export function createPaneInjector(tmux: McpTmux, pane: string, canReceive: () => boolean, onInject: () => void, onDrop: (reason: string) => void): Injector {
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
  return createRecipientInjector({ canReceive, paste: data => transfer(data, true), write: data => transfer(data, false), onInject, onDrop });
}
