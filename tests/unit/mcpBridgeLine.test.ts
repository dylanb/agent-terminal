import { describe, expect, it } from 'vitest';
import { bridgeLineReader, encodeBridgeMessage, type BridgeMessage } from '../../src/shared/mcpBridge';

describe('a bridge peer that sends a line past the size limit', () => {
  it.each(['one chunk', 'two chunks'])('rejects a complete oversized message in %s and reads the following message', mode => {
    const messages: (BridgeMessage | null)[] = [];
    const feed = bridgeLineReader(message => messages.push(message));
    const line = encodeBridgeMessage({ type: 'result', value: 'x'.repeat(17 * 1024 * 1024) });
    if (mode === 'two chunks') {
      const half = Math.floor(line.length / 2);
      feed(line.slice(0, half));
      feed(line.slice(half) + encodeBridgeMessage({ type: 'ack' }));
    } else {
      feed(line + encodeBridgeMessage({ type: 'ack' }));
    }
    expect(messages.map(message => message?.type ?? null)).toEqual([null, 'ack']);
  });

  it('is answered as an unreadable line once, and the next line is still read', () => {
    const messages: (BridgeMessage | null)[] = [];
    const feed = bridgeLineReader((message) => messages.push(message));
    feed('x'.repeat(17 * 1024 * 1024));
    feed(encodeBridgeMessage({ type: 'ack' }));
    expect(messages).toEqual([null, { type: 'ack' }]);
  });
});
