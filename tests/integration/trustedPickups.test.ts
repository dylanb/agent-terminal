import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustedPickups } from '../../src/main/trustedPickups';
import type { AppLoopBootstrap } from '../../src/main/appLoopState';
import { inProgressRunIdentity, type RunIdentity } from '../../src/main/gateRunState';

// §27.10 — the pickup a run completed holds that run's turns and gate side-effects, including for a run resumed
// across a relaunch; a pickup an earlier run left never does.

const PICKUP: AppLoopBootstrap = { pr: 233, branch: 'plan-loop/issue-218', issue: 218, initialStatus: 'planning' };
const RUN: RunIdentity = { flow: 'feature-dev-v3', startedAt: 1792407818398 };

let repo: string;
let current: RunIdentity | null;
let failures: string[];
let forgetFailures: string[];
const relaunch = () =>
  createTrustedPickups({
    currentRun: () => current,
    persistFailed: (_repo, reason) => failures.push(reason),
    forgetFailed: (_repo, reason) => forgetFailures.push(reason),
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'trusted-pickups-'));
  current = RUN;
  failures = [];
  forgetFailures = [];
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('a run keeps the pickup it completed across a relaunch', () => {
  it('is still trusted by a relaunched app while the same run is in progress', () => {
    relaunch().set(repo, PICKUP);
    expect(relaunch().get(repo)).toEqual(PICKUP);
  });

  it('is not trusted once a different run is in progress', () => {
    relaunch().set(repo, PICKUP);
    current = { ...RUN, startedAt: RUN.startedAt + 1 };
    expect(relaunch().get(repo)).toBeUndefined();
    current = { ...RUN, flow: 'other-flow' };
    expect(relaunch().get(repo)).toBeUndefined();
  });

  it('is not trusted when no run is in progress', () => {
    relaunch().set(repo, PICKUP);
    current = null;
    expect(relaunch().get(repo)).toBeUndefined();
  });

  it('is forgotten for good once deleted, by this app and by a relaunched one', () => {
    const app = relaunch();
    app.set(repo, PICKUP);
    app.delete(repo);
    expect(app.get(repo)).toBeUndefined();
    expect(relaunch().get(repo)).toBeUndefined();
  });

  it('can be deleted by a relaunched app that never loaded it', () => {
    relaunch().set(repo, PICKUP);
    relaunch().delete(repo);
    expect(relaunch().get(repo)).toBeUndefined();
  });

  it('keeps each worktree’s pickup separate', () => {
    const other = mkdtempSync(join(tmpdir(), 'trusted-pickups-other-'));
    try {
      relaunch().set(repo, PICKUP);
      expect(relaunch().get(other)).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the run is the one flow-state.yaml says is in progress (#155)', () => {
  const flowState = (startedAt: number, status = 'in_progress'): void => {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `step: plan\nstatus: ${status}\nflow: ${RUN.flow}\nstarted_at: ${startedAt}\n`);
  };
  const app = () =>
    createTrustedPickups({
      currentRun: inProgressRunIdentity,
      persistFailed: (_repo, reason) => failures.push(reason),
      forgetFailed: (_repo, reason) => forgetFailures.push(reason),
    });

  it('a relaunch mid-run trusts the pickup that run completed', () => {
    flowState(RUN.startedAt);
    app().set(repo, PICKUP);
    expect(app().get(repo)).toEqual(PICKUP);
    expect(failures).toEqual([]);
  });

  it('a relaunch into a later run never acts on the pickup an earlier run left', () => {
    flowState(RUN.startedAt);
    app().set(repo, PICKUP);
    flowState(RUN.startedAt + 60_000);
    expect(app().get(repo)).toBeUndefined();
  });

  it('a relaunch after the run finished trusts nothing', () => {
    flowState(RUN.startedAt);
    app().set(repo, PICKUP);
    flowState(RUN.startedAt, 'done');
    expect(app().get(repo)).toBeUndefined();
  });
});

describe('the persisted record fails closed', () => {
  const file = (): string => join(repo, '.agent-terminal', 'loop', 'run-pickup.yaml');

  it.each([
    ['garbled YAML', '{{{'],
    ['a non-mapping', '- 1\n'],
    ['an unknown schema', 'schema_version: 99\nflow: feature-dev-v3\nstarted_at: 1792407818398\npr: 233\nbranch: b\nissue: 218\ninitial_status: planning\n'],
    ['a non-positive PR', 'schema_version: 1\nflow: feature-dev-v3\nstarted_at: 1792407818398\npr: 0\nbranch: b\nissue: 218\ninitial_status: planning\n'],
    ['a blank branch', 'schema_version: 1\nflow: feature-dev-v3\nstarted_at: 1792407818398\npr: 233\nbranch: " "\nissue: 218\ninitial_status: planning\n'],
  ])('trusts nothing from %s', (_name, body) => {
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(file(), body);
    expect(relaunch().get(repo)).toBeUndefined();
  });

  it('first run: with no `.agent-terminal` root, a set creates the tree and a relaunch reads it back', () => {
    rmSync(join(repo, '.agent-terminal'), { recursive: true, force: true });
    relaunch().set(repo, PICKUP);
    expect(existsSync(file())).toBe(true);
    expect(relaunch().get(repo)).toEqual(PICKUP);
  });

  it('a set that cannot persist is reported, and this app still trusts the pickup', () => {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'loop'), 'not a directory\n');
    const app = relaunch();
    app.set(repo, PICKUP);
    expect(failures).toHaveLength(1);
    expect(app.get(repo)).toEqual(PICKUP);
  });

  it('a set with no run in progress is reported, and this app still trusts the pickup', () => {
    current = null;
    const app = relaunch();
    app.set(repo, PICKUP);
    expect(failures).toHaveLength(1);
    expect(app.get(repo)).toEqual(PICKUP);
  });

  it('a delete that cannot remove the file is reported, does not throw, and this app stops trusting the pickup', () => {
    const app = relaunch();
    app.set(repo, PICKUP);
    rmSync(file());
    mkdirSync(join(file(), 'in-the-way'), { recursive: true });
    expect(() => app.delete(repo)).not.toThrow();
    expect(forgetFailures).toHaveLength(1);
    expect(app.get(repo)).toBeUndefined();
  });

  it('a restore puts back a pickup a failed transition deleted, for this app and a relaunched one, and reports nothing', () => {
    const app = relaunch();
    app.set(repo, PICKUP);
    app.delete(repo);
    app.restore(repo, PICKUP);
    expect(app.get(repo)).toEqual(PICKUP);
    expect(relaunch().get(repo)).toEqual(PICKUP);
    expect(failures).toEqual([]);
  });

  it('a restore with no run in progress keeps the pickup in this app only, and reports nothing', () => {
    current = null;
    const app = relaunch();
    app.restore(repo, PICKUP);
    expect(app.get(repo)).toEqual(PICKUP);
    expect(failures).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });

  it('a set of a pickup the reader would refuse is reported as not saved', () => {
    relaunch().set(repo, { ...PICKUP, branch: ' ' });
    expect(failures).toHaveLength(1);
    expect(existsSync(file())).toBe(false);
  });

  it('never writes a .gitignore, and leaves an existing one byte-for-byte unchanged (§19.1/§25)', () => {
    const gitignore = join(repo, '.gitignore');
    writeFileSync(gitignore, '# operator-owned\n');
    relaunch().set(repo, PICKUP);
    expect(readFileSync(gitignore, 'utf8')).toBe('# operator-owned\n');
    expect(existsSync(join(repo, '.agent-terminal', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal', 'loop', '.gitignore'))).toBe(false);
  });
});
