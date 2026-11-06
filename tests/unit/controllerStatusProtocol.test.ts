import { expect, it } from 'vitest';
import { encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
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

const statusFrame = (extra: Record<string, unknown>) => JSON.stringify({ version: 2, type: 'status', work: { ...workStatus(), ...extra } });

it.each([
  ['no title or branch', {}],
  ['null title and branch', { title: null, branch: null }],
  ['a title and a branch', { title: 'Show live controller status', branch: 'feature/card-identity' }],
  ['an empty title string', { title: '', branch: 'main' }],
  ['a title with no branch', { title: 'Only a title' }],
  ['a branch with no title', { branch: 'only-a-branch' }],
])('accepts a status carrying %s and delivers it unchanged', (_, extra) => {
  expect(parseControllerMessage(statusFrame(extra))).toEqual({ version: 2, type: 'status', work: { ...workStatus(), ...extra } });
});

it.each([
  ['a numeric title', { title: 7 }],
  ['an object title', { title: { text: 'x' } }],
  ['an array title', { title: ['x'] }],
  ['a boolean title', { title: true }],
  ['a numeric branch', { branch: 7 }],
  ['an object branch', { branch: { name: 'main' } }],
  ['an array branch', { branch: ['main'] }],
  ['a valid title beside a malformed branch', { title: 'Fine', branch: 12 }],
])('rejects a status carrying %s at the wire boundary', (_, extra) => {
  expect(() => parseControllerMessage(statusFrame(extra))).toThrow();
});

it('replaces an oversized status with a fallback that carries neither title nor branch', () => {
  const huge = 'x'.repeat(1024 * 1024);
  const fallback = parseControllerMessage(encodeControllerMessage({
    version: 2, type: 'status', work: workStatus({ title: 'Identity that must not survive', branch: 'branch-that-must-not-survive', error: { reason: huge } }),
  }));
  expect(fallback).toMatchObject({ type: 'status', work: { unavailableReason: 'message-too-large' } });
  expect(JSON.stringify(fallback)).not.toMatch(/must not survive/);
  expect(fallback.type === 'status' ? [fallback.work.title, fallback.work.branch] : []).toEqual([undefined, undefined]);
});
