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
