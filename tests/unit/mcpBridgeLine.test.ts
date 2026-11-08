import { describe, expect, it } from 'vitest';
import { bridgeLineReader, encodeBridgeMessage, type BridgeMessage } from '../../src/shared/mcpBridge';

describe('a bridge peer that sends a line past the size limit', () => {
  it('is answered as an unreadable line once, and the next line is still read', () => {
    const messages: (BridgeMessage | null)[] = [];
    const feed = bridgeLineReader((message) => messages.push(message));
    feed('x'.repeat(17 * 1024 * 1024));
    feed(encodeBridgeMessage({ type: 'ack' }));
    expect(messages).toEqual([null, { type: 'ack' }]);
  });
});
