import { expect, it } from 'vitest';
import { createControllerDecoder, encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
import { workStatus } from '../helpers/controllerStatusFixture';

it('rejects malformed status at the wire boundary', () => {
  for (const work of [null, {}, workStatus({ activity: 'bad' as never }), workStatus({ attention: { status: 'error', reasons: [12 as never] } })]) {
    expect(() => parseControllerMessage(JSON.stringify({ version: 1, type: 'status', work }))).toThrow();
  }
});

it('delivers long unicode reasons losslessly across arbitrary socket reads', () => {
  const work = workStatus({ error: { reason: 'é🙂\\"\n'.repeat(10000) } });
  const bytes = new TextEncoder().encode(encodeControllerMessage({ version: 1, type: 'status', work }));
  const decoder = createControllerDecoder();
  const received = [];
  for (let offset = 0; offset < bytes.length; offset += 113) received.push(...decoder.push(bytes.subarray(offset, offset + 113)));
  expect(received).toEqual([{ version: 1, type: 'status', work }]);
});

it('rejects array-shaped enum values instead of coercing them into valid status', () => {
  for (const work of [
    { ...workStatus(), activity: ['active'] },
    { ...workStatus(), flow: { availability: 'known', name: 'work', step: 'test', assignment: ['assigned'] } },
  ]) expect(() => parseControllerMessage(JSON.stringify({ version: 1, type: 'status', work }))).toThrow();
});
