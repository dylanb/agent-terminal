import { expect, it } from 'vitest';
import { parseControllerMessage, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import { workStatus } from '../helpers/controllerStatusFixture';

const budget = 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text);
it('delivers exactly the accepted UTF-8 snapshot budget and replaces larger snapshots explicitly', () => {
  const base = { version: 1 as const, type: 'status' as const, work: workStatus({ error: { reason: '' } }) };
  const overhead = bytes(JSON.stringify(base)).length;
  const reason = 'é'.repeat(Math.floor((budget - overhead) / 2)) + 'a'.repeat((budget - overhead) % 2);
  const accepted = { ...base, work: workStatus({ error: { reason } }) };
  expect(bytes(JSON.stringify(accepted))).toHaveLength(budget);
  expect(parseControllerMessage(encodeControllerMessage(accepted))).toEqual(accepted);
  const oversized = { ...base, work: workStatus({ error: { reason: reason + 'a' } }) };
  const fallback = parseControllerMessage(encodeControllerMessage(oversized));
  expect(fallback).toMatchObject({ type: 'status', work: { unavailableReason: 'message-too-large', flow: { availability: 'unavailable' }, activity: 'unavailable' } });
  expect(parseControllerMessage(encodeControllerMessage(base))).toEqual(base);
});
