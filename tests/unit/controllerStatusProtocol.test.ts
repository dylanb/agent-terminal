import { expect, it } from 'vitest';
import { parseControllerMessage } from '../../src/shared/controllerProtocol';
import { workStatus } from '../helpers/controllerStatusFixture';

it('rejects malformed status at the wire boundary', () => {
  for (const work of [null, {}, workStatus({ activity: 'bad' as never }), workStatus({ attention: { status: 'error', reasons: [12 as never] } })]) {
    expect(() => parseControllerMessage(JSON.stringify({ version: 2, type: 'status', work }))).toThrow();
  }
});

it('rejects array-shaped enum values instead of coercing them into valid status', () => {
  for (const work of [
    { ...workStatus(), activity: ['active'] },
    { ...workStatus(), flow: { availability: 'known', name: 'work', step: 'test', assignment: ['assigned'] } },
  ]) expect(() => parseControllerMessage(JSON.stringify({ version: 2, type: 'status', work }))).toThrow();
});

it('accepts a status with no loop message, an empty one, a loop error and a notice', () => {
  for (const loopMessage of [undefined, null, { id: 'm1', kind: 'error', reason: 'the turn stalled' }, { id: 'm2', kind: 'notice', reason: 'nothing to commit' }]) {
    const work = { ...workStatus(), ...(loopMessage === undefined ? {} : { loopMessage }) };
    expect(parseControllerMessage(JSON.stringify({ version: 2, type: 'status', work }))).toEqual({ version: 2, type: 'status', work });
  }
});

it('rejects a malformed loop message at the wire boundary', () => {
  for (const loopMessage of [{}, 'stalled', { id: '', kind: 'error', reason: 'x' }, { id: 'm', kind: 'warning', reason: 'x' }, { id: 'm', kind: 'error', reason: 7 }, { id: 3, kind: 'notice', reason: 'x' }]) {
    expect(() => parseControllerMessage(JSON.stringify({ version: 2, type: 'status', work: { ...workStatus(), loopMessage } }))).toThrow();
  }
});
