import { expect, it } from 'vitest';
import { createLoopNotifier } from '../../src/main/loopNotifier';
import type { FlowStateView } from '../../src/shared/ipc';
import type { NotificationCondition } from '../helpers/controllerNotifications';

const repo = '/notification-source';
const halted = { deciding: false, hung: false, haltReasons: [{ reason: 'stop-for-a-human' as const }] };
const deciding = { deciding: true, hung: false, haltReasons: [] };
const view = (humanNeeded: boolean, status = 'complete'): FlowStateView => ({
  stepName: 'red', runStarted: 'started', steps: ['red'], position: 1, total: 1, status: 'in_progress',
  loop: { status, iteration: 1, humanNeeded, pr: null, branch: null, ready: false, autoGate: humanNeeded ? halted : deciding },
});

function source() {
  const notifier: ReturnType<typeof createLoopNotifier> & {
    current?: (repoKey: string) => NotificationCondition | null;
  } = createLoopNotifier({
    isFocused: () => false, onFocusChanged() {}, notify: () => () => {}, focusWindow() {}, reveal() {},
  });
  return notifier;
}

it('exposes no current notification before a qualifying stop', () => {
  const notifier = source();
  notifier.observe(repo, view(false, 'working'));
  expect(notifier.current?.(repo)).toBeNull();
});

it('exposes the current qualifying stop and its message from production flow observations', () => {
  const notifier = source();
  notifier.observe(repo, view(true));
  expect(notifier.current?.(repo)).toEqual({ conditionId: expect.stringMatching(/\S/), message: 'complete · iter 1' });
});

it('preserves a continuing stop identity across status changes', () => {
  const notifier = source();
  notifier.observe(repo, view(true, 'error'));
  const first = notifier.current?.(repo);
  notifier.observe(repo, view(true, 'complete'));
  const continued = notifier.current?.(repo);
  expect(Boolean(first?.conditionId && continued?.conditionId && first.conditionId === continued.conditionId)).toBe(true);
});

it('clears current information when the qualifying stop ends', () => {
  const notifier = source();
  notifier.observe(repo, view(true));
  notifier.observe(repo, view(false, 'working'));
  expect(notifier.current?.(repo)).toBeNull();
});

it('gives a new stop a fresh identity even with identical text and iteration', () => {
  const notifier = source();
  notifier.observe(repo, view(true));
  const first = notifier.current?.(repo);
  notifier.observe(repo, view(false, 'working'));
  notifier.observe(repo, view(true));
  const next = notifier.current?.(repo);
  expect(Boolean(first?.conditionId && next?.conditionId && first.conditionId !== next.conditionId)).toBe(true);
});
