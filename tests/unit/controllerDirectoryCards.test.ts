import { expect, it } from 'vitest';
import { directoryCards } from '../../src/shared/controllerCards';
import { directoryConflictFixture } from '../helpers/controllerStatusFixture';

it.each([false, true])('exposes conflict identity without a representative connection (reversed: %s)', reversed => {
  const { members, unrelated } = directoryConflictFixture();
  const pair = members.slice(0, 2);
  const cards = directoryCards([...(reversed ? pair.reverse() : pair), unrelated]);
  const conflict = cards.find(card => card.launchDirectory === members[0].launchDirectory);
  expect(conflict?.kind).toBe('conflict');
  if (conflict?.kind !== 'conflict') throw new Error('Expected a conflict card');
  expect({ ...conflict, activationTargets: new Set(conflict.activationTargets) }).toEqual({
    kind: 'conflict',
    launchDirectory: members[0].launchDirectory,
    repositoryRoot: members[0].repositoryRoot,
    activationTargets: new Set([members[0].id, members[1].id]),
  });
});

it('exposes current work and activation only for the single live connection', () => {
  const { members } = directoryConflictFixture();
  expect(directoryCards([members[1]])).toEqual([{
    kind: 'single',
    launchDirectory: members[1].launchDirectory,
    repositoryRoot: members[1].repositoryRoot,
    work: members[1].work,
    activationTargets: [members[1].id],
  }]);
});

it('exposes only the retained occurrence for dismissal after disconnection', () => {
  const { members } = directoryConflictFixture();
  expect(directoryCards([{ ...members[1], status: 'disconnected' }])).toEqual([{
    kind: 'disconnected',
    launchDirectory: members[1].launchDirectory,
    repositoryRoot: members[1].repositoryRoot,
    dismissOccurrenceId: members[1].id,
  }]);
});

it.each(['returned card', 'source snapshot'] as const)('isolates nested work when the %s is mutated', target => {
  const { members } = directoryConflictFixture();
  const source = members[0];
  const original = structuredClone(source.work);
  const first = directoryCards([source])[0];
  const other = directoryCards([source])[0];
  if (first.kind !== 'single' || other.kind !== 'single' || !first.work) throw new Error('Expected single cards with work');
  const work = target === 'returned card' ? first.work : source.work;
  if (work.ticket.availability !== 'known' || work.ticket.title.availability !== 'known' || !work.attention || !work.error) {
    throw new Error('Expected a known ticket, attention and error in the fixture');
  }
  Reflect.set(work.ticket.title, 'text', 'Changed title');
  Reflect.set(work.attention.reasons, '0', 'Changed reason');
  Reflect.set(work.error, 'reason', 'Changed error');
  expect(other.work).toEqual(original);
  expect(target === 'returned card' ? source.work : first.work).toEqual(original);
  const later = directoryCards([source])[0];
  if (later.kind !== 'single') throw new Error('Expected a single card');
  expect(later.work).toEqual(source.work);
});
