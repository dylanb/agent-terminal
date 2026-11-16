import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { readPickupRecord, writeAdoptedPickupIntent } from '../../src/main/appLoopState';

// #304 — the pickup record's adopted forms, read back through the public reader.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'adopted-record-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.agent-terminal', 'loop'), { recursive: true });
  return dir;
};
const writeRecord = (dir: string, doc: Record<string, unknown>): void => writeFileSync(join(dir, '.agent-terminal', 'loop', 'bootstrap.yaml'), dump(doc));

describe('readPickupRecord — the adopted forms', () => {
  it('reads an adoption that has touched no ref yet as pending', () => {
    const dir = repo();
    writeAdoptedPickupIntent(dir, { pr: 41, fixBranch: 'agent-terminal/review-pr-41-1700000000000' });
    expect(readPickupRecord(dir)).toEqual({ kind: 'pending' });
  });

  it('reads a pending adoption without its fix branch as invalid', () => {
    const dir = repo();
    writeRecord(dir, { schema_version: 1, status: 'pending', kind: 'adopted', pr: 41 });
    expect(readPickupRecord(dir).kind).toBe('invalid');
  });

  it('reads a record of an unknown kind as invalid, even when it holds a ticket pickup', () => {
    const dir = repo();
    writeRecord(dir, { schema_version: 1, status: 'complete', kind: 'other', pr: 42, branch: 'plan-loop/issue-77', issue: 77, initial_status: 'planning' });
    expect(readPickupRecord(dir).kind).toBe('invalid');
  });
});
