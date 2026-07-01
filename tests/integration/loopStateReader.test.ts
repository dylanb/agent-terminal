import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { readLoopExtension } from '../../src/main/loopStateReader';

// §26.6 — the orchestrator reads back the engine-extension fields it writes (phase2_active, the §26.8
// impasse tracking, the §26.5 persona_state), which are NOT part of the §24.2.3 mirror slice. This reader
// degrades every missing/ill-typed field to its default so a foreign or partial state.yaml is safe.
describe('loop state.yaml extension reader (§26.6)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopread-'));
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const write = (doc: Record<string, unknown>): void =>
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump({ schema_version: 4, ...doc }));

  it('reads phase2_active back as written', () => {
    write({ status: 'plan-draft', iteration: 2, phase2_active: true });
    expect(readLoopExtension(repo).phase2Active).toBe(true);
  });

  it('defaults phase2_active to false when the field is absent', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).phase2Active).toBe(false);
  });

  it('reads the §26.8 impasse tracking back as written', () => {
    write({ status: 'plan-draft', iteration: 2, impasse: { consecutive_identical: 2, last_findings_sig: 'sigA' } });
    expect(readLoopExtension(repo).impasse).toEqual({ consecutiveIdentical: 2, lastFindingsSig: 'sigA' });
  });

  it('defaults the impasse tracking to a zero run + empty signature when absent or ill-typed', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).impasse).toEqual({ consecutiveIdentical: 0, lastFindingsSig: '' });
  });

  it('reads the §26.5 persona_state footprints back as written', () => {
    write({
      status: 'plan-draft',
      iteration: 2,
      persona_state: { 'review-principal': { last_clean_iter: 1, last_seen_plan_digest: 'D', last_seen_files: ['a.ts'] } },
    });
    expect(readLoopExtension(repo).personaState).toEqual({
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: 'D', lastSeenFiles: ['a.ts'] },
    });
  });

  it('defaults each persona_state entry field a partial map omits', () => {
    write({ status: 'plan-draft', iteration: 2, persona_state: { 'review-security': { last_clean_iter: 3 } } });
    expect(readLoopExtension(repo).personaState).toEqual({
      'review-security': { lastCleanIter: 3, lastSeenPlanDigest: '', lastSeenFiles: [] },
    });
  });

  it('defaults persona_state to an empty map when absent', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).personaState).toEqual({});
  });

  it('defaults to a safe extension for a missing or unreadable state.yaml (never throws)', () => {
    rmSync(join(repo, '.agent-loop'), { recursive: true, force: true });
    expect(readLoopExtension(repo)).toEqual({
      phase2Active: false,
      impasse: { consecutiveIdentical: 0, lastFindingsSig: '' },
      personaState: {},
    });
  });
});
