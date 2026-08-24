import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readEpicPromotion,
  writeEpicPromotion,
  writeAppLoopState,
  type EpicPromotionState,
} from '../../src/main/appLoopState';

// §28.7 AC3 — the resumable promotion record: its OWN disjoint file promotion.yaml (a wholesale run-state
// rewrite cannot clobber it — the baseline/changed-tests precedent), carrying NO wall-clock so an idempotent
// re-run's "unchanged" assertion is deterministic, and failing toward NOT re-creating duplicate public issues.

let repo: string;
const promotionFile = (): string => join(repo, '.agent-terminal', 'loop', 'promotion-176.yaml');
const STATE: EpicPromotionState = { epic: 176, created: [{ index: 1, issue: 501, title: 'Slice one' }, { index: 2, issue: 502, title: 'Slice two' }], trackingAppended: true, prClosed: false };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'epic-promotion-store-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('promotion.yaml store (§28.7 AC3)', () => {
  it('reads null when no store exists (a fresh promotion)', () => {
    expect(readEpicPromotion(repo, 176)).toBeNull();
  });

  it('round-trips the created sub-tickets + the append/close flags for the same epic', () => {
    writeEpicPromotion(repo, STATE);
    expect(readEpicPromotion(repo, 176)).toEqual(STATE);
  });

  it('a DIFFERENT epic reads from its OWN file — one epic cannot clobber another epic\'s resume record', () => {
    writeEpicPromotion(repo, STATE); // epic 176
    expect(readEpicPromotion(repo, 999)).toBeNull(); // epic 999 has no file of its own
    expect(readEpicPromotion(repo, 176)).toEqual(STATE); // 176's record is untouched
  });

  it('reads "corrupt" for a present-but-unparseable store — blocking, never fall-through to re-create (SEC-1)', () => {
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(promotionFile(), 'this: is: not: valid: yaml: [\n');
    expect(readEpicPromotion(repo, 176)).toBe('corrupt');
  });

  it('reads "corrupt" for every malformed field (the fail-safe guards each — CWE-20/770)', () => {
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    const cases = [
      'schema_version: 1\nepic: 176\ncreated: "nope"\n', // created not an array
      'schema_version: 999\nepic: 176\ncreated: []\n', // wrong schema_version
      'schema_version: 1\nepic: 0\ncreated: []\n', // non-positive epic
      'schema_version: 1\nepic: 176\ncreated:\n  - index: 1\n    issue: 0\n    title: x\n', // non-positive issue (#0 does not exist)
      'schema_version: 1\nepic: 176\ncreated:\n  - index: 1\n    issue: 501\n', // sub-ticket missing its title
    ];
    for (const yaml of cases) {
      writeFileSync(promotionFile(), yaml);
      expect(readEpicPromotion(repo, 176), yaml).toBe('corrupt');
    }
  });

  it('carries NO wall-clock field, and a SECOND write of equal state is byte-identical (AC3 determinism)', () => {
    writeEpicPromotion(repo, STATE);
    const first = readFileSync(promotionFile(), 'utf8');
    expect(first).not.toContain('updated_at');
    writeEpicPromotion(repo, STATE); // re-write the same state
    expect(readFileSync(promotionFile(), 'utf8')).toBe(first); // byte-stable across re-writes
  });

  it('is created on a FRESH tree (first-run writer deletes the loop dir first)', () => {
    rmSync(join(repo, '.agent-terminal'), { recursive: true, force: true });
    writeEpicPromotion(repo, STATE);
    expect(readEpicPromotion(repo, 176)).toEqual(STATE);
  });

  it('is disjoint from run-state.yaml — writing it leaves run-state byte-for-byte unchanged', () => {
    writeAppLoopState(repo, { loop: 'plan-bundle-loop', step: 'plan-bundle', turnKey: 'consolidate-plan-bundle', status: 'complete', verdict: 'clean' });
    const runStatePath = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
    const before = readFileSync(runStatePath, 'utf8');
    writeEpicPromotion(repo, STATE);
    expect(readFileSync(runStatePath, 'utf8')).toBe(before);
  });
});
