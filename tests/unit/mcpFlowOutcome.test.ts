import { expect, it } from 'vitest';
import * as outcomes from '../../src/main/mcpFlowOutcome';
import type { FlowStateView } from '../../src/shared/ipc';
import { toolResult } from '../../src/main/mcpTools';

const view = (status: FlowStateView['status']): FlowStateView => ({ stepName: 'plan', steps: ['plan'], position: 1, total: 1, status, runStarted: status === 'not_started' ? 'never-started' : 'started' });
const answer = (value: unknown) => toolResult({ kind: 'answered', value });
it('a refused start names the reason and is not reported as taken', () => {
  const result = answer(outcomes.startedAnswer?.({ ...view('not_started'), notice: 'another window holds this worktree' }, null));
  expect({ error: result.isError, text: result.content[0].text }).toEqual({ error: true, text: expect.stringContaining('another window holds this worktree') });
});
it('a successful start reports pickup when entry starts it', () => {
  const result = answer(outcomes.startedAnswer?.(view('in_progress'), { kind: 'taken', message: 'Pickup started.' }));
  expect({ error: result.isError, text: result.content[0].text }).toEqual({ error: false, text: expect.stringContaining('Pickup started.') });
});
it('a failed termination names its failure and does not claim termination', () => {
  const result = answer(outcomes.terminatedAnswer?.({ outcome: 'refused', cause: 'failed', reason: 'EACCES', view: view('in_progress') }));
  expect({ error: result.isError, text: result.content[0].text }).toEqual({ error: true, text: expect.stringContaining('EACCES') });
});
it('a reset is reported as terminated', () => {
  const result = answer(outcomes.terminatedAnswer?.({ outcome: 'reset', view: view('not_started') }));
  expect({ error: result.isError, text: result.content[0].text }).toEqual({ error: false, text: expect.stringContaining('Terminated') });
});
