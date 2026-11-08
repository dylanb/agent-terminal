import { connect } from 'node:net';
import { bridgeLineReader, encodeBridgeMessage, type AckTimers, type WindowCallOutcome, type WindowRequest } from '../shared/mcpBridge';
import { errMsg } from './errno';

/** The server's end of the bridge: one call to the window at `endpoint`. The window must acknowledge within
 *  `ackTimeoutMs`; once it has, the call waits for the operation however long it takes. */
export function callWindow<H>(
  endpoint: string,
  request: WindowRequest,
  opts: { build: string; ackTimeoutMs: number; timers: AckTimers<H> },
): Promise<WindowCallOutcome> {
  return new Promise((resolve) => {
    let stage: 'waiting-ack' | 'started' | 'settled' = 'waiting-ack';
    let deadline: { handle: H } | null = null;
    const stopDeadline = (): void => {
      if (deadline) opts.timers.clearTimer(deadline.handle);
      deadline = null;
    };
    const socket = connect(endpoint);
    const settle = (outcome: WindowCallOutcome): void => {
      if (stage === 'settled') return;
      stage = 'settled';
      stopDeadline();
      socket.destroy();
      resolve(outcome);
    };
    const lost = (reason: string): void =>
      settle(stage === 'started' ? { kind: 'result-unknown', reason } : { kind: 'app-unreachable', reason });
    deadline = { handle: opts.timers.setTimer(() => lost(`the window did not acknowledge within ${opts.ackTimeoutMs} ms`), opts.ackTimeoutMs) };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encodeBridgeMessage({ type: 'hello', build: opts.build })));
    socket.on('data', bridgeLineReader((message) => {
      if (stage === 'waiting-ack') {
        if (message?.type === 'ack') {
          stage = 'started';
          stopDeadline();
          socket.write(encodeBridgeMessage({ type: 'call', request }));
        } else if (message?.type === 'other-build') {
          lost('the window runs another build of agent-terminal; restart the window to use the installed build');
        } else {
          lost('the window answered in a form this build does not read');
        }
      } else if (stage === 'started') {
        if (message?.type === 'result') settle({ kind: 'answered', value: message.value });
        else if (message?.type === 'failed') lost(`the window failed the action: ${message.reason}`);
        else lost('the window answered in a form this build does not read');
      }
    }));
    socket.on('error', (error) => lost(errMsg(error)));
    socket.on('close', () => lost('the connection to the window was lost'));
  });
}
