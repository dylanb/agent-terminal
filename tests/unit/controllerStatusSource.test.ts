import { expect, it } from 'vitest';
import { createControllerStatus } from '../../src/main/controllerStatus';
import type { ControllerWorkStatus } from '../../src/shared/ipc';

it.each([0, Infinity, Number.MAX_SAFE_INTEGER + 1])('keeps known work visible when persisted ticket %s is invalid', number => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', view: {
      stepName: 'work', steps: ['work'], position: 1, total: 1, status: 'in_progress', runStarted: 'started', refs: { ticket: number },
    } }),
    issueTitle: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    expect(shown).toMatchObject({ flow: { availability: 'known', name: 'delivery', assignment: 'assigned' }, activity: 'active', ticket: { availability: 'unavailable' } });
  } finally { source.dispose(); }
});
