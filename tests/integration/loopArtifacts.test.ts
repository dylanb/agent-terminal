import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seedLoopArtifacts,
  seedAppStateFiles,
  plantLoopLeafSymlink,
  plantAppStateParentSymlink,
  LOOP_DIR_REL,
  APP_STATE_DIR_REL,
  CAN_SYMLINK,
} from '../helpers/loopArtifacts';
import { isUnderAppStateDir } from '../../src/main/appStateDirs';
import { roundReportRel, consolidatorOutputRel } from '../../src/main/appLoopState';

// Self-test for the #126 discovery fixtures (tests/helpers/loopArtifacts.ts). It pins the fixture's own
// observable output — the files on disk, the POSIX relPaths returned, and how the PRODUCTION predicate
// (isUnderAppStateDir) classifies them — so a fixture that silently seeds the wrong tree can't make every
// downstream RED/GREEN discovery test lie. It asserts nothing about discover(); that is the slice's job.

const onDisk = (repo: string, rel: string): string => join(repo, ...rel.split('/'));

describe('loopArtifacts fixtures — seeded loop tree', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loop-fixt-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('seeds the run-state file as a depth-0 child of loop/ and three files nested one level down', () => {
    const p = seedLoopArtifacts(repo);
    expect(p.runState).toBe(`${LOOP_DIR_REL}/run-state.yaml`);
    expect(p.plan).toBe(`${LOOP_DIR_REL}/artifacts/plan.md`);
    // Pin the fixture's report/consolidate seed paths to the engine's own exported resolvers, so an engine
    // rename of those subtrees moves both the fixture and this pin together (CLAUDE.md writer↔reader-location).
    expect(p.report).toBe(roundReportRel(1));
    expect(p.consolidate).toBe(consolidatorOutputRel(1));
    // Depth-0 run-state is one segment under loop/; the other three are nested one deeper — the "at any
    // depth" cases the walk must enumerate.
    const loopDepth = LOOP_DIR_REL.split('/').length;
    expect(p.runState.split('/')).toHaveLength(loopDepth + 1);
    for (const rel of [p.plan, p.report, p.consolidate]) expect(rel.split('/')).toHaveLength(loopDepth + 2);
  });

  it('writes every returned loop relPath to disk with its distinct markdown body', () => {
    const p = seedLoopArtifacts(repo);
    for (const rel of p.all) expect(existsSync(onDisk(repo, rel))).toBe(true);
    expect(readFileSync(onDisk(repo, p.plan), 'utf8')).toContain('# Loop plan');
    expect(readFileSync(onDisk(repo, p.report), 'utf8')).toContain('# Round 1 report');
    expect(readFileSync(onDisk(repo, p.consolidate), 'utf8')).toContain('# Round 1 consolidation');
  });

  it('classifies every loop file as app-state under the loop subtree (the filter-then-re-add setup)', () => {
    // Each loop file is ITSELF under `.agent-terminal/` (so the #126 app-state filter drops it) yet lies
    // under `.agent-terminal/loop/` (so the `...loop` re-add is what restores exactly this subtree).
    for (const rel of seedLoopArtifacts(repo).all) {
      expect(isUnderAppStateDir(rel)).toBe(true);
      expect(rel.startsWith(`${LOOP_DIR_REL}/`)).toBe(true);
    }
  });
});

describe('loopArtifacts fixtures — seeded app-state files', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loop-fixt-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('seeds the four state files directly under the app-state dir, none under the loop subtree', () => {
    const s = seedAppStateFiles(repo);
    expect(s.flowState).toBe(`${APP_STATE_DIR_REL}/flow-state.yaml`);
    expect(s.all).toEqual([
      `${APP_STATE_DIR_REL}/flow-state.yaml`,
      `${APP_STATE_DIR_REL}/todos.json`,
      `${APP_STATE_DIR_REL}/monitor-events.json`,
      `${APP_STATE_DIR_REL}/audit-pointer.yaml`,
    ]);
    const rootDepth = APP_STATE_DIR_REL.split('/').length;
    for (const rel of s.all) {
      expect(existsSync(onDisk(repo, rel))).toBe(true);
      expect(rel.split('/')).toHaveLength(rootDepth + 1); // a DIRECT child of `.agent-terminal/`
      expect(isUnderAppStateDir(rel)).toBe(true); // app state the #126 filter must drop…
      expect(rel.startsWith(`${LOOP_DIR_REL}/`)).toBe(false); // …and the `...loop` re-add must NOT restore
    }
  });
});

describe.skipIf(!CAN_SYMLINK)('loopArtifacts fixtures — CWE-59 symlink planters', () => {
  let repo: string;
  let external: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loop-fixt-'));
    external = mkdtempSync(join(tmpdir(), 'loop-ext-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  it('plants the loop leaf as a symlink to an out-of-repo dir (final segment is the link)', () => {
    plantLoopLeafSymlink(repo, external);
    const leaf = onDisk(repo, LOOP_DIR_REL);
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readlinkSync(leaf)).toBe(external);
    expect(lstatSync(onDisk(repo, APP_STATE_DIR_REL)).isDirectory()).toBe(true); // parent is a real dir
  });

  it('plants the app-state parent as a symlink whose target holds a real loop/ (the leaf-only-check miss)', () => {
    mkdirSync(join(external, 'loop'), { recursive: true });
    plantAppStateParentSymlink(repo, external);
    const parent = onDisk(repo, APP_STATE_DIR_REL);
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(readlinkSync(parent)).toBe(external);
  });
});
