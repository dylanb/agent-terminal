import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRoundReportReader, roundReportRel } from '../../src/main/appLoopState';
import { readLatestRoundReport } from '../../src/main/mcpWindowState';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(reports: Record<number, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-latest-report-')));
  dirs.push(dir);
  for (const [round, text] of Object.entries(reports)) {
    const file = join(dir, roundReportRel(Number(round)));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe("the round report a session reads of its window's loop", () => {
  it('is the reviewed round\'s own report, never an earlier or later round\'s, and none when it is missing', async () => {
    const read = createRoundReportReader(() => {});
    const reports = repo({ 1: '{"round":1}', 2: '{"round":2}', 5: '{"round":5}' });
    expect({
      own: await read(reports, 2),
      missing: await read(repo({ 1: '{"round":1}' }), 2),
      none: await read(repo({}), 1),
    }).toEqual({ own: { round: 2 }, missing: null, none: null });
  });

  it('is none for a report that cannot be read, logging it once however often it is read', async () => {
    const logged: string[] = [];
    const read = createRoundReportReader((line) => logged.push(line));
    const halfWritten = repo({ 1: '{"round":1}', 2: '{"rou' });
    expect({ first: await read(halfWritten, 2), again: await read(halfWritten, 2), logged: logged.length }).toEqual({ first: null, again: null, logged: 1 });
  });
});

describe("the report read_state gives for its window's loop", () => {
  const atLoop = (loop: Partial<FlowLoopView>): FlowStateView => ({
    stepName: 'plan',
    steps: ['plan', 'done'],
    position: 1,
    total: 2,
    status: 'in_progress',
    runStarted: 'started',
    loop: { status: 'running', iteration: 1, pr: null, branch: null, ready: false, humanNeeded: false, gateOptions: [], appTurn: { step: 'plan', turnKey: 'review-plan' }, ...loop },
  });

  it('passes over a report an earlier step left at the running round, and reads the round once it is reviewed', async () => {
    const read = createRoundReportReader(() => {});
    const leftover = repo({ 1: '{"round":1}', 2: '{"round":"earlier step"}' });
    expect({
      reviewing: await readLatestRoundReport(leftover, atLoop({ iteration: 2 }), read),
      firstRound: await readLatestRoundReport(leftover, atLoop({ iteration: 1 }), read),
      reviewed: await readLatestRoundReport(repo({ 1: '{"round":1}', 2: '{"round":2}' }), atLoop({ iteration: 2, verdict: 'clean' }), read),
    }).toEqual({ reviewing: { round: 1 }, firstRound: null, reviewed: { round: 2 } });
  });
});
