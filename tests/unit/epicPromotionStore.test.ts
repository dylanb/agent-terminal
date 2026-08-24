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
const promotionFile = (): string => join(repo, '.agent-terminal', 'loop', 'promotion.yaml');
const STATE: EpicPromotionState = { epic: 176, created: [{ index: 1, issue: 501 }, { index: 2, issue: 502 }], trackingAppended: true, prClosed: false };

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

  it('reads null for a DIFFERENT epic than the one recorded (a stale record, fresh promotion)', () => {
    writeEpicPromotion(repo, STATE);
    expect(readEpicPromotion(repo, 999)).toBeNull();
  });

  it('reads "corrupt" for a present-but-unparseable store — blocking, never fall-through to re-create (SEC-1)', () => {
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(promotionFile(), 'this: is: not: valid: yaml: [\n');
    expect(readEpicPromotion(repo, 176)).toBe('corrupt');
  });

  it('reads "corrupt" for a malformed record (created not an array of {index,issue})', () => {
    mkdirSync(join(repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(promotionFile(), 'schema_version: 1\nepic: 176\ncreated: "nope"\n');
    expect(readEpicPromotion(repo, 176)).toBe('corrupt');
  });

  it('carries NO wall-clock field (a re-write is byte-stable, so the AC3 unchanged assertion is deterministic)', () => {
    writeEpicPromotion(repo, STATE);
    const raw = readFileSync(promotionFile(), 'utf8');
    expect(raw).not.toContain('updated_at');
    expect(readFileSync(promotionFile(), 'utf8')).toBe(raw); // stable across reads
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
