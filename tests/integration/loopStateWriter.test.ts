import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
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
});
