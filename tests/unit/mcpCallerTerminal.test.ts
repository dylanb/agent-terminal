import { expect, it } from 'vitest';
import { encodeBridgeMessage, parseBridgeMessage } from '../../src/shared/mcpBridge';

it('carries the caller’s absolute tmux socket through the window bridge', () => {
  const caller = { session: 42, tmux: { socket: '/tmp/operator path/tmux.sock', searchPath: '/opt/user/bin:/usr/bin' } };
  const message = { type: 'call' as const, request: { tool: 'read_state', args: {} }, caller };
  expect(parseBridgeMessage(encodeBridgeMessage(message))).toEqual(message);
});

it.each(['relative/socket', '', '/tmp/bad\0socket', 7])('ignores malformed tmux metadata: %s', tmuxSocket => {
  expect(parseBridgeMessage(JSON.stringify({ type: 'call', request: { tool: 'read_state', args: {} }, caller: { session: 42, tmux: { socket: tmuxSocket, searchPath: '/usr/bin' } } })))
    .toEqual({ type: 'call', request: { tool: 'read_state', args: {} }, caller: { session: 42 } });
});
