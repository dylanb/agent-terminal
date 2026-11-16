import { expect, it } from 'vitest';
import { fileSpan } from '../../src/main/agentUsage/fileSpan';

it('runs from a file\'s creation time to its last-modified time', () => {
  expect(fileSpan({ created: 1_782_000_000_250, modified: 1_782_000_090_125 })).toEqual({ from: 1_782_000_000_250, to: 1_782_000_090_125 });
});

it('reads a creation time the system reports as 0 as times that cannot be read', () => {
  expect(fileSpan({ created: 0, modified: 1_782_000_090_125 })).toBe('times-unreadable');
});

it('reads a missing creation time or last-modified time as times that cannot be read', () => {
  expect([fileSpan({ modified: 1_782_000_090_125 }), fileSpan({ created: 1_782_000_000_250 }), fileSpan({})]).toEqual([
    'times-unreadable',
    'times-unreadable',
    'times-unreadable',
  ]);
});

it('reads a time that is not a number of milliseconds as one that cannot be read', () => {
  expect([fileSpan({ created: Number.NaN, modified: 1_782_000_090_125 }), fileSpan({ created: 1_782_000_000_250, modified: Number.POSITIVE_INFINITY })]).toEqual([
    'times-unreadable',
    'times-unreadable',
  ]);
});

it('spans both times when a copy kept a last-modified time older than its creation', () => {
  expect(fileSpan({ created: 1_782_000_090_125, modified: 1_782_000_000_250 })).toEqual({ from: 1_782_000_000_250, to: 1_782_000_090_125 });
});
