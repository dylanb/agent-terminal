import { expect, it } from 'vitest';
import { CONTROLLER_MAX_MESSAGE_BYTES, parseControllerMessage } from '../../src/shared/controllerProtocol';

const condition = { conditionId: 'stop-7', message: 'Review release 7' };

it.each([
  { version: 2, type: 'notification', notification: condition },
  { version: 2, type: 'notification-current', notification: condition },
  { version: 2, type: 'notification-current', notification: null },
])('decodes the notification contract: $type $notification', message => {
  let decoded: unknown;
  try { decoded = parseControllerMessage(JSON.stringify(message)); }
  catch (error) { decoded = error; }
  expect(decoded).toEqual(message);
});

it.each([
  null,
  {},
  { conditionId: '', message: 'review' },
  { conditionId: 'stop', message: 7 },
  { conditionId: ['stop'], message: 'review' },
  { conditionId: 'stop', message: 'x'.repeat(CONTROLLER_MAX_MESSAGE_BYTES) },
])('rejects an invalid notification arrival %j', notification => {
  expect(() => parseControllerMessage(JSON.stringify({ version: 2, type: 'notification', notification }))).toThrow();
});
