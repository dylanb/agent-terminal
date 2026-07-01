import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allReviewsPresent, consolidatedVerdict } from '../../src/main/reviewArtifacts';

// §26.3/D47a(b) + §26.4 — the reviewers turn is artifact-confirmed: it is "done" only when EVERY roster
// persona's review JSON exists AND parses. A missing or malformed one keeps the turn un-confirmed so the
// orchestrator retries it (then errors), rather than advancing on a partial fan-out.
describe('reviewer fan-out artifact detection (§26.4 / §26.3 D47a)', () => {
  const personas = ['review-principal', 'review-security', 'review-architecture'];
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'reviews-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const writeReview = (iter: number, persona: string, body: string): void => {
    const dir = join(repo, '.agent-loop', 'reviews', String(iter));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${persona}.json`), body);
  };

  it('is true only when every roster persona JSON for the iteration is present and parses', () => {
    for (const p of personas) writeReview(2, p, '{"verdict":"clean"}');
    expect(allReviewsPresent(repo, 2, personas)).toBe(true);
  });

  it('is false when a single roster persona JSON is missing', () => {
    writeReview(2, 'review-principal', '{"verdict":"clean"}');
    writeReview(2, 'review-security', '{"verdict":"needs-work"}');
    // review-architecture absent
    expect(allReviewsPresent(repo, 2, personas)).toBe(false);
  });

  it('is false when a persona JSON exists but does not parse (§26.3 b: must parse)', () => {
    writeReview(2, 'review-principal', '{"verdict":"clean"}');
    writeReview(2, 'review-security', '{"verdict":"clean"}');
    writeReview(2, 'review-architecture', 'not json {{{');
    expect(allReviewsPresent(repo, 2, personas)).toBe(false);
  });

  it('keys off the iteration directory (a prior iteration’s reviews do not satisfy this one)', () => {
    for (const p of personas) writeReview(1, p, '{"verdict":"clean"}');
    expect(allReviewsPresent(repo, 2, personas)).toBe(false);
  });
});

// §26.3/D45 + §26.13 L4 — the consolidate turn's artifact-confirmed check: the consolidator's
// reviews/<iter>/consolidated.json exists, parses, and carries a `verdict` string. The orchestrator
// reads that raw verdict (normalized against the LoopDef taxonomy elsewhere) to branch (§26.6).
describe('consolidated verdict detection (§26.3 D45 / §26.13 L4)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'consolidated-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const writeConsolidated = (iter: number, body: string): void => {
    const dir = join(repo, '.agent-loop', 'reviews', String(iter));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'consolidated.json'), body);
  };

  it('returns the raw verdict string when consolidated.json exists, parses, and carries one', () => {
    writeConsolidated(1, '{"verdict":"clean","findings_kept":[]}');
    expect(consolidatedVerdict(repo, 1)).toBe('clean');
    writeConsolidated(2, '{"verdict":"needs-work"}');
    expect(consolidatedVerdict(repo, 2)).toBe('needs-work');
  });

  it('returns null when consolidated.json is absent for the iteration', () => {
    expect(consolidatedVerdict(repo, 1)).toBeNull();
  });

  it('returns null when consolidated.json exists but does not parse', () => {
    writeConsolidated(1, 'not json {{{');
    expect(consolidatedVerdict(repo, 1)).toBeNull();
  });

  it('returns null when consolidated.json parses but carries no string verdict', () => {
    writeConsolidated(1, '{"findings_kept":[]}');
    expect(consolidatedVerdict(repo, 1)).toBeNull();
  });

  it('keys off the iteration directory (a prior iteration’s consolidated does not satisfy this one)', () => {
    writeConsolidated(1, '{"verdict":"clean"}');
    expect(consolidatedVerdict(repo, 2)).toBeNull();
  });
});
