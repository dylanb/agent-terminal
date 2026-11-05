import { expect, it } from 'vitest';
import type { ControllerWorkStatus } from '../../src/shared/ipc';

type StatusChanges = (previous: ControllerWorkStatus | undefined, next: ControllerWorkStatus) => string[];
const loaded = import('../../src/shared/controllerTimeline').catch(() => null);
const changes = async (previous: ControllerWorkStatus | undefined, next: ControllerWorkStatus): Promise<string[]> => {
  const module = await loaded as { statusChanges?: StatusChanges } | null;
  return module?.statusChanges?.(previous, next) as string[];
};

const running = { availability: 'known', name: 'feature-dev', step: 'implement', assignment: 'assigned' } as const;
const base = (overrides: Partial<ControllerWorkStatus> = {}): ControllerWorkStatus => ({
  flow: running,
  ticket: { availability: 'known', number: 301, title: { availability: 'known', text: 'Cards' } },
  activity: 'active', attention: null, error: null, ...overrides,
});

it('Working to Idle is one entry naming Idle', async () => {
  const result = await changes(base({ activity: 'active' }), base({ activity: 'quiet' }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('Idle');
});

it('Idle to Working is one entry naming Working', async () => {
  const result = await changes(base({ activity: 'quiet' }), base({ activity: 'active' }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('Working');
});

it('a move to Activity unavailable is one entry', async () => {
  const result = await changes(base({ activity: 'active' }), base({ activity: 'unavailable' }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('Activity unavailable');
});

it('an unchanged activity is no entry', async () => {
  expect(await changes(base({ activity: 'quiet' }), base({ activity: 'quiet' }))).toEqual([]);
});

it('a flow error appearing is one entry and clearing is one entry', async () => {
  const appeared = await changes(base(), base({ error: { reason: 'Step exited 1' } }));
  const cleared = await changes(base({ error: { reason: 'Step exited 1' } }), base());
  expect.soft(appeared).toHaveLength(1);
  expect.soft(cleared).toHaveLength(1);
  expect.soft(cleared?.[0]).not.toBe(appeared?.[0]);
});

it('a flow error whose text changes while it stays present is no entry', async () => {
  expect(await changes(base({ error: { reason: 'Step exited 1' } }), base({ error: { reason: 'Step exited 2' } }))).toEqual([]);
});

it('a request clearing is one entry', async () => {
  const result = await changes(base({ attention: { status: 'complete', reasons: ['Approve'] } }), base());
  expect(result).toHaveLength(1);
});

it('a request whose reasons change while it stays present is no entry', async () => {
  expect(await changes(
    base({ attention: { status: 'complete', reasons: ['Approve'] } }),
    base({ attention: { status: 'complete', reasons: ['Approve', 'Budget'] } }),
  )).toEqual([]);
});

it('a flow step change is one entry naming the new step', async () => {
  const result = await changes(base(), base({ flow: { ...running, step: 'review' } }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('review');
});

it('a run starting together with its first step is one entry', async () => {
  const result = await changes(
    base({ flow: { availability: 'known', name: 'feature-dev', step: 'plan', assignment: 'unassigned' } }),
    base({ flow: { availability: 'known', name: 'feature-dev', step: 'implement', assignment: 'assigned' } }),
  );
  expect(result).toHaveLength(1);
});

it('a run finishing on its last step is one entry containing Completed', async () => {
  const result = await changes(base(), base({ flow: { ...running, assignment: 'completed' } }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('Completed');
});

it('a run finishing together with a step change is still one entry', async () => {
  const result = await changes(base(), base({ flow: { availability: 'known', name: 'feature-dev', step: 'finalize', assignment: 'completed' } }));
  expect(result).toHaveLength(1);
  expect(result?.[0]).toContain('Completed');
});

it('the first report after registration has no previous work and is no entry', async () => {
  expect(await changes(undefined, base({ activity: 'quiet', error: { reason: 'Step exited 1' }, attention: { status: 'complete', reasons: ['x'] } }))).toEqual([]);
});

it('a report changing only reasons, ticket, loop message, title or branch is no entry', async () => {
  const before = base({ title: 'Old', branch: 'old', loopMessage: null });
  const after = base({
    title: 'New', branch: 'new',
    ticket: { availability: 'known', number: 302, title: { availability: 'loading' } },
    loopMessage: { id: 'm', kind: 'notice', reason: 'nothing to commit' },
  });
  expect(await changes(before, after)).toEqual([]);
});

it('two dimensions changing in one report give one entry each', async () => {
  const result = await changes(base({ activity: 'active' }), base({ activity: 'quiet', error: { reason: 'Step exited 1' } }));
  expect(result).toHaveLength(2);
  expect(result?.some(text => text.includes('Idle'))).toBe(true);
});
