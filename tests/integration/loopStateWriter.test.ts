import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { writeLoopState } from '../../src/main/loopStateWriter';
import { parseAgentLoopState } from '../../src/main/agentLoopBridge';

// §26.6 — the app is now the WRITER of .agent-loop/state.yaml (it was read-only in §24.2.3 T2). A write
// is whole-document and valid v4 so the T2 mirror, the §25 audit, and any future Go re-handoff can read
// it. These tests pin: (a) the read set round-trips through the existing mirror parser; (b) the
// whole-document write surface is present; (c) the no-.gitignore-writes rule (CLAUDE.md).
describe('loop state.yaml writer (§26.6)', () => {
  let repo: string;
  const fixedNow = (): Date => new Date('2026-06-30T12:00:00.000Z');
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopwrite-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const L1_STATE = {
    status: 'plan-draft',
    iteration: 1,
    pr: 42,
    branch: 'plan-loop/issue-176',
    boundLoop: 'plan-loop',
    linkedIssues: [176],
  };

  it('round-trips the §24.2.3 read set through the existing mirror parser', () => {
    writeLoopState(repo, L1_STATE, fixedNow);
    expect(parseAgentLoopState(repo)).toEqual({
      status: 'plan-draft',
      iteration: 1,
      pr: 42,
      branch: 'plan-loop/issue-176',
      linkedIssues: [176],
    });
  });

  it('writes a whole-document valid v4 doc: bare numeric schema_version + the §26.6 write surface', () => {
    writeLoopState(repo, L1_STATE, fixedNow);
    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    // Bare number 4 (engine writes bare; the mirror coerces) — not the quoted "4" a LoopDef uses.
    expect(doc.schema_version).toBe(4);
    expect(doc.bound_loop).toBe('plan-loop');
    expect(doc.linked_issues).toEqual([176]);
    expect(doc.updated_at).toBe('2026-06-30T12:00:00.000Z');
    // Whole-document: the LoopExtension fields the orchestrator owns are present, defaulted.
    for (const key of ['sessions', 'impasse', 'phase2_active', 'persona_state', 'completed_loops', 'terminated']) {
      expect(doc, `missing whole-document key ${key}`).toHaveProperty(key);
    }
  });

  it('writes atomically — no leftover .tmp file beside state.yaml', () => {
    writeLoopState(repo, L1_STATE, fixedNow);
    const entries = readdirSync(join(repo, '.agent-loop'));
    expect(entries).toContain('state.yaml');
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('creates NO .gitignore (CLAUDE.md: the app never edits the user VCS config)', () => {
    writeLoopState(repo, L1_STATE, fixedNow);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-loop', '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged', () => {
    const original = '# my ignores\nnode_modules\n.agent-terminal/\n';
    writeFileSync(join(repo, '.gitignore'), original);
    writeLoopState(repo, L1_STATE, fixedNow);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(original);
  });

  it('creates the .agent-loop directory if absent', () => {
    expect(existsSync(join(repo, '.agent-loop'))).toBe(false);
    writeLoopState(repo, L1_STATE, fixedNow);
    expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(true);
  });

  it('preserves engine-owned fields the app does not model when overwriting an existing doc (§26.6 re-handoff)', () => {
    // The app writes a whole document but does not yet USE the LoopExtension fields (§26.5/§26.8 read
    // persona_state / impasse in later slices). A write must therefore preserve any non-default values a
    // prior writer (the §26.6 "future Go re-handoff", or a later app slice) left, not reset the document
    // to defaults on every status change. Seed a doc carrying real extension state, then write a status
    // change through the orchestrator's writer and assert the engine-owned state survives.
    const seeded = {
      schema_version: 4,
      pr: 42,
      branch: 'plan-loop/issue-176',
      iteration: 3,
      status: 'plan-draft',
      bound_loop: 'plan-loop',
      linked_issues: [176],
      persona_state: { 'review-principal': { last_clean_iter: 2 } },
      impasse: { consecutive_identical: 1, last_findings_sig: 'abc123' },
      phase2_active: true,
      human_notes: ['human asked for a smaller plan'],
      completed_loops: ['some-prior-loop'],
    };
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump(seeded));

    writeLoopState(repo, { ...L1_STATE, iteration: 3, status: 'error' }, fixedNow);

    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.status).toBe('error'); // the app-owned field is updated
    expect(doc.persona_state).toEqual({ 'review-principal': { last_clean_iter: 2 } }); // engine state survives
    expect(doc.impasse).toEqual({ consecutive_identical: 1, last_findings_sig: 'abc123' });
    expect(doc.phase2_active).toBe(true);
    expect(doc.human_notes).toEqual(['human asked for a smaller plan']);
    expect(doc.completed_loops).toEqual(['some-prior-loop']);
  });

  it('applies the §26.6 gate write surface OVER the merged prior doc (phase2/persona_state/terminated)', () => {
    // L5 — a request-changes gate transition sets phase2_active, CLEARS persona_state (every persona
    // re-reviews next round), and an impasse/approve terminate sets terminated. These app-owned writes
    // must WIN over the preserved prior values, not be masked by the merge that keeps engine state.
    const seeded = {
      schema_version: 4,
      status: 'awaiting-human-plan-approval',
      iteration: 2,
      persona_state: { 'review-principal': { last_clean_iter: 2 } },
      phase2_active: false,
      terminated: false,
    };
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump(seeded));

    writeLoopState(
      repo,
      { ...L1_STATE, iteration: 3, status: 'plan-draft', phase2Active: true, clearPersonaState: true },
      fixedNow,
    );
    let doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.phase2_active).toBe(true);
    expect(doc.persona_state).toEqual({}); // cleared despite the prior entry
    expect(doc.terminated).toBe(false); // untouched write leaves the prior value

    writeLoopState(repo, { ...L1_STATE, status: 'impasse', terminated: true }, fixedNow);
    doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.terminated).toBe(true);
  });

  it('heals a PARTIAL prior doc back to whole-document v4 (back-fills missing LoopExtension fields)', () => {
    // §26.6's whole-document guarantee must survive a prior doc that is itself partial (a hand-edit, an
    // older app version, or the re-handoff engine could leave one). Preserve the fields it DOES carry,
    // but back-fill the ones it is missing with defaults — never propagate the gap.
    const partial = {
      schema_version: 4,
      status: 'plan-draft',
      iteration: 2,
      persona_state: { 'review-security': { last_clean_iter: 1 } }, // engine field present — must survive
      // impasse, sessions, phase2_active, terminated, … all MISSING
    };
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump(partial));

    writeLoopState(repo, { ...L1_STATE, iteration: 2, status: 'error' }, fixedNow);

    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.persona_state).toEqual({ 'review-security': { last_clean_iter: 1 } }); // present field preserved
    for (const key of ['sessions', 'impasse', 'phase2_active', 'severity_cycle_iter', 'completed_loops', 'terminated']) {
      expect(doc, `partial prior doc not healed: missing ${key}`).toHaveProperty(key); // back-filled
    }
  });

  it('writes the §26.8 impasse tracking OVER the merged prior doc', () => {
    // The stuck detector (§26.8) persists the running signature + identical-count each consolidate. Like
    // the other gate-surface writes it must WIN over any preserved prior impasse value.
    const seeded = { schema_version: 4, status: 'plan-draft', iteration: 2, impasse: { consecutive_identical: 1, last_findings_sig: 'old' } };
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump(seeded));

    writeLoopState(
      repo,
      { ...L1_STATE, iteration: 2, status: 'plan-draft', impasse: { consecutiveIdentical: 2, lastFindingsSig: 'sigA' } },
      fixedNow,
    );
    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.impasse).toEqual({ consecutive_identical: 2, last_findings_sig: 'sigA' });
  });

  it('writes the §26.5 persona_state skip footprints OVER the merged prior doc', () => {
    // The skip-opt (§26.5) persists each clean persona's last-clean iteration + footprint. Writing an
    // explicit persona_state must WIN over the preserved prior map (it is a fresh full snapshot each round).
    const seeded = { schema_version: 4, status: 'plan-draft', iteration: 2, persona_state: { 'review-security': { last_clean_iter: 1 } } };
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump(seeded));

    writeLoopState(
      repo,
      {
        ...L1_STATE,
        iteration: 2,
        status: 'plan-draft',
        personaState: { 'review-principal': { lastCleanIter: 2, lastSeenPlanDigest: 'D', lastSeenFiles: [] } },
      },
      fixedNow,
    );
    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.persona_state).toEqual({
      'review-principal': { last_clean_iter: 2, last_seen_plan_digest: 'D', last_seen_files: [] },
    });
  });

  it('writes the §26.10 cost OVER the merged prior doc, and preserves it across a later cost-less write', () => {
    // The cost meter (§26.10) persists the display-only per-iteration cost at the iteration boundary. Like
    // the other extension writes it wins over any preserved prior value; a later write that carries no cost
    // must PRESERVE the last recorded cost (merge from the prior doc), so the strip keeps showing it.
    writeLoopState(repo, { ...L1_STATE, iteration: 1, cost: { usd: 0.42, unpricedModels: ['x-unknown'] } }, fixedNow);
    let doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.cost).toEqual({ usd: 0.42, unpriced: ['x-unknown'] });

    // A subsequent status-only write (no cost field) preserves the prior cost via the merge.
    writeLoopState(repo, { ...L1_STATE, iteration: 1, status: 'awaiting-human-plan-approval' }, fixedNow);
    doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc.cost).toEqual({ usd: 0.42, unpriced: ['x-unknown'] });
  });

  it('emits the whole read set present even when branch is null and linkedIssues is empty (§26.6)', () => {
    // The read set must be uniformly present (defaulted), the way `pr` is — not conditionally omitted.
    writeLoopState(repo, { ...L1_STATE, branch: null, linkedIssues: [] }, fixedNow);
    const doc = yaml.load(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc).toHaveProperty('branch');
    expect(doc).toHaveProperty('linked_issues');
    expect(doc.linked_issues).toEqual([]);
  });
});
