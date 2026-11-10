import { expect, it } from 'vitest';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { FlowStateView } from '../../src/shared/ipc';

it.each([true, false])('loop disappearance ends only a per-step stop (per-step=%s)', perStep => {
  const source = createLoopNotifier();
  const received: string[] = [];
  source.subscribe(notification => received.push(notification.message));
  const view: FlowStateView = {
    stepName: 'green', runStarted: 'started', steps: ['green'], position: 1, total: 1, status: 'in_progress',
    loop: { status: 'complete', iteration: 1, humanNeeded: true, pr: null, branch: null, ready: false,
      ...(perStep ? { autoGate: { deciding: false, hung: false, haltReasons: [{ reason: 'stop-for-a-human' as const }] } } : {}),
    },
  };
  source.observe('/work', view);
  const first = source.current('/work');
  source.observe('/work', { ...view, loop: undefined });
  expect(source.current('/work')).toBeNull();
  source.observe('/work', view);
  expect(received).toEqual(Array(perStep ? 2 : 1).fill('complete · iter 1'));
  if (perStep) expect(source.current('/work')?.conditionId).not.toBe(first?.conditionId);
});
