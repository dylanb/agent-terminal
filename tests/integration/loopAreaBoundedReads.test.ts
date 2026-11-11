// The app's own state files in a working tree's loop area are repository content: a named pipe planted at one
// is refused instead of read, so it cannot freeze the main process, and a file past its size limit is refused
// instead of read in full.

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_DONE_REL_PATH, APP_LOOP_DIR_SEGMENTS } from '../../src/main/appLoopPaths';
import {
  armInterrupt,
  MAX_LOOP_AREA_FILE_BYTES,
  probeArmedInterrupt,
  readAppLoopState,
  readBaselineCommit,
  readChangedTests,
  readEpicPromotion,
  readPickupRecord,
  readSliceBrief,
  recordBaselineCommit,
  recordChangedTests,
  writeAppLoopBootstrap,
  writeAppLoopState,
  writeEpicPromotion,
  writeSliceBrief,
} from '../../src/main/appLoopState';
import { resolveJail } from '../../src/main/confinedPath';
import { readGateRunState, writeGateRunState, type RunIdentity } from '../../src/main/gateRunState';
import { createTrustedPickups } from '../../src/main/trustedPickups';
import { MAX_TURN_DONE_BYTES, readTurnDone } from '../../src/main/turnDoneFile';
import { createFedPipes } from '../helpers/fedPipe';

const RUN: RunIdentity = { flow: 'feature-dev-v3', startedAt: 1792407818398 };
const SHA = 'a'.repeat(40);

let repo: string;
const pipes = createFedPipes();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'loop-area-bounded-')));
});

afterEach(async () => {
  await pipes.reap();
  rmSync(repo, { recursive: true, force: true });
});

const trustedPickups = () =>
  createTrustedPickups({ currentRun: () => RUN, persistFailed: () => undefined, forgetFailed: () => undefined });

/** The one file `write` adds to the loop area, so the test uses the path the app's own writer chose. */
function writtenFile(write: () => void): string {
  const dir = resolveJail(repo, ...APP_LOOP_DIR_SEGMENTS);
  if (dir === null) throw new Error('loop area unresolvable');
  const list = (): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const before = new Set(list());
  write();
  const added = list().filter((n) => !before.has(n));
  if (added.length !== 1) throw new Error(`expected one new loop-area file, got ${added.join(', ')}`);
  return join(dir, added[0]);
}

interface Reader {
  name: string;
  write(): void;
  read(): unknown;
  refused: unknown;
}

const readers: Reader[] = [
  {
    name: 'the run state',
    write: () => writeAppLoopState(repo, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }),
    read: () => readAppLoopState(repo),
    refused: null,
  },
  {
    name: 'the pickup record',
    write: () => writeAppLoopBootstrap(repo, { kind: 'opened', pr: 233, branch: 'plan-loop/issue-218', issue: 218, initialStatus: 'planning' }),
    read: () => readPickupRecord(repo).kind,
    refused: 'invalid',
  },
  {
    name: 'the armed interrupt flag',
    write: () => armInterrupt(repo, 'plan'),
    read: () => probeArmedInterrupt(repo),
    refused: { kind: 'unreadable' },
  },
  {
    name: 'the slice brief',
    write: () => writeSliceBrief(repo, { slice: 2, fromStep: 'plan', text: 'the second slice' }),
    read: () => readSliceBrief(repo),
    refused: null,
  },
  {
    name: 'the baseline commit',
    write: () => void recordBaselineCommit(repo, 'feature', SHA),
    read: () => readBaselineCommit(repo),
    refused: null,
  },
  {
    name: 'the changed-tests flag',
    write: () => recordChangedTests(repo, 'green', ['tests/a.test.ts']),
    read: () => readChangedTests(repo),
    refused: null,
  },
  {
    name: 'the epic promotion record',
    write: () => writeEpicPromotion(repo, { epic: 7, created: [{ index: 1, issue: 8, title: 'a' }], trackingAppended: false, prClosed: false }),
    read: () => readEpicPromotion(repo, 7),
    refused: 'corrupt',
  },
  {
    name: 'the gate state',
    write: () => writeGateRunState(repo, { run: RUN, loopRun: null, failedEffect: null, relaunchHalt: null }),
    read: () => readGateRunState(repo).kind,
    refused: 'unreadable',
  },
  {
    name: 'the run pickup',
    write: () => trustedPickups().set(repo, { kind: 'opened', pr: 233, branch: 'plan-loop/issue-218', issue: 218, initialStatus: 'planning' }),
    read: () => trustedPickups().get(repo),
    refused: undefined,
  },
];

describe('a loop-area state file that is a named pipe is refused, not read', () => {
  it.each(readers)('$name', (r) => {
    const file = writtenFile(r.write);
    const content = readFileSync(file, 'utf8');
    rmSync(file);
    pipes.at(file, content);
    expect(r.read()).toEqual(r.refused);
  });

  it('the turn done-signal', () => {
    pipes.at(join(repo, APP_DONE_REL_PATH), 'work-plan\n');
    expect(readTurnDone(repo, join(...APP_LOOP_DIR_SEGMENTS))).toBeNull();
  });
});

describe('a loop-area state file past its size limit is refused, not read', () => {
  it.each(readers)('$name', (r) => {
    const file = writtenFile(r.write);
    appendFileSync(file, `\n# ${'x'.repeat(MAX_LOOP_AREA_FILE_BYTES)}\n`);
    expect(r.read()).toEqual(r.refused);
  });

  it('the turn done-signal', () => {
    const file = join(repo, APP_DONE_REL_PATH);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `work-plan\n${' '.repeat(MAX_TURN_DONE_BYTES)}`);
    expect(readTurnDone(repo, join(...APP_LOOP_DIR_SEGMENTS))).toBeNull();
  });
});
