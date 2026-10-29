import { expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startControllerTransport } from '../../src/main/controllerTransport';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import { CONTROLLER_MAX_STATUS_BYTES } from '../../src/shared/controllerProtocol';
import type { ControllerTerminal, FlowStateView } from '../../src/shared/ipc';
import { workStatus } from '../helpers/controllerStatusFixture';

it.each(['capacity', 'throw', 'callback'] as const)('contains notification transport %s failure without interrupting source observation', async failure => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'at-nf-')));
  const registry = await startControllerTransport(home);
  const source = createLoopNotifier();
  const view = (status: string, humanNeeded = true): FlowStateView => ({
    stepName: 'green', runStarted: 'started', steps: ['green'], position: 1, total: 1, status: 'in_progress',
    loop: { status, iteration: 1, humanNeeded, pr: null, branch: null, ready: false },
  });
  let disconnected: ControllerTerminal | undefined;
  const unsubscribe = registry.subscribeTerminals(terminals => {
    disconnected ??= terminals.find(terminal => terminal.status === 'disconnected');
  });
  const stop = registerControllerTerminal(home, { launchDirectory: '/work', repositoryRoot: '/work' }, () => 'activated', () => {},
    listener => { listener(workStatus()); return () => {}; }, () => {}, source);
  try {
    await expect.poll(() => registry.terminals()[0]?.work).toEqual(workStatus());
    source.observe('/work', view('first'));
    await expect.poll(() => registry.terminals()[0]?.latestNotification?.message).toBe('first · iter 1');
    if (failure === 'capacity') {
      vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(CONTROLLER_MAX_STATUS_BYTES);
    } else {
      const send = WebSocket.prototype.send;
      vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, options, callback) {
        if (typeof data === 'string' && JSON.parse(data).type === 'notification') {
          const error = new Error('notification transport failed');
          if (failure === 'throw') throw error;
          const complete = typeof options === 'function' ? options as (error?: Error) => void : callback;
          queueMicrotask(() => complete?.(error));
          return;
        }
        Reflect.apply(send, this, [data, options, callback]);
      });
    }
    expect(() => source.observe('/work', view('second'))).not.toThrow();
    await expect.poll(() => disconnected?.status).toBe('disconnected');
    expect(disconnected?.latestNotification?.message).toBe('first · iter 1');
    expect(source.current('/work')?.message).toBe('second · iter 1');
    source.observe('/work', view('working', false));
    expect(source.current('/work')).toBeNull();
    source.observe('/work', view('third'));
    expect(source.current('/work')?.message).toBe('third · iter 1');
  } finally {
    stop(); unsubscribe(); vi.restoreAllMocks();
    await registry.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
