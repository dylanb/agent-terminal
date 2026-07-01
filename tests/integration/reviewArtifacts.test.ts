import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  allReviewsPresent,
  consolidatedVerdict,
  consolidatedFindings,
  personaVerdict,
  carryForwardReviews,
  planDigest,
} from '../../src/main/reviewArtifacts';

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

  // §26.8 — the stuck detector reads the consolidated `findings_kept` to compute the finding signature.
  it('reads the kept findings (severity + message) for the iteration', () => {
    writeConsolidated(
      1,
      '{"verdict":"needs-work","findings_kept":[{"severity":"blocker","message":"a"},{"severity":"minor","message":"b"}]}',
    );
    expect(consolidatedFindings(repo, 1)).toEqual([
      { severity: 'blocker', message: 'a' },
      { severity: 'minor', message: 'b' },
    ]);
  });

  it('returns an empty kept set when findings_kept is absent, malformed, or the file does not parse', () => {
    writeConsolidated(1, '{"verdict":"clean"}'); // no findings_kept
    expect(consolidatedFindings(repo, 1)).toEqual([]);
    writeConsolidated(2, 'not json {{{');
    expect(consolidatedFindings(repo, 2)).toEqual([]);
    expect(consolidatedFindings(repo, 3)).toEqual([]); // absent file
  });

  it('drops findings_kept entries that lack a string severity or message (best-effort)', () => {
    writeConsolidated(
      1,
      '{"findings_kept":[{"severity":"major","message":"ok"},{"severity":"major"},{"message":"x"},"nope"]}',
    );
    expect(consolidatedFindings(repo, 1)).toEqual([{ severity: 'major', message: 'ok' }]);
  });
});

// §26.5/§26.13 L6 — the skip-opt reads each persona's own verdict (to record who was clean) and carries a
// pruned persona's last-clean review forward to the current iteration (its review is reused, not re-run).
describe('persona review reuse (§26.5 / §26.13 L6)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'personareuse-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const writeReview = (iter: number, persona: string, body: string): void => {
    const dir = join(repo, '.agent-loop', 'reviews', String(iter));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${persona}.json`), body);
  };

  it('reads a persona review verdict string, or null when absent / unparseable / verdict-less', () => {
    writeReview(1, 'review-principal', '{"verdict":"clean"}');
    expect(personaVerdict(repo, 1, 'review-principal')).toBe('clean');
    writeReview(1, 'review-security', 'not json {{{');
    expect(personaVerdict(repo, 1, 'review-security')).toBeNull();
    writeReview(1, 'review-architecture', '{"notes":"x"}');
    expect(personaVerdict(repo, 1, 'review-architecture')).toBeNull();
    expect(personaVerdict(repo, 1, 'review-intent')).toBeNull(); // absent
  });

  it('carries the named personas last-clean reviews forward, byte-for-byte, to the target iteration', () => {
    writeReview(1, 'review-principal', '{"verdict":"clean","seen_iter":1}');
    writeReview(1, 'review-security', '{"verdict":"clean","seen_iter":1}');
    carryForwardReviews(repo, ['review-principal', 'review-security'], 1, 2);
    expect(readFileSync(join(repo, '.agent-loop', 'reviews', '2', 'review-principal.json'), 'utf8')).toBe(
      '{"verdict":"clean","seen_iter":1}',
    );
    expect(readFileSync(join(repo, '.agent-loop', 'reviews', '2', 'review-security.json'), 'utf8')).toBe(
      '{"verdict":"clean","seen_iter":1}',
    );
  });

  it('skips a persona whose source review is missing (best-effort, never throws)', () => {
    writeReview(1, 'review-principal', '{"verdict":"clean"}');
    carryForwardReviews(repo, ['review-principal', 'review-absent'], 1, 2);
    expect(existsSync(join(repo, '.agent-loop', 'reviews', '2', 'review-principal.json'))).toBe(true);
    expect(existsSync(join(repo, '.agent-loop', 'reviews', '2', 'review-absent.json'))).toBe(false);
  });

  it('digests plan.md as the plan-phase footprint: identical content → identical digest, edit → different', () => {
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n\nbody\n');
    const d1 = planDigest(repo);
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n\nbody\n'); // identical rewrite
    expect(planDigest(repo)).toBe(d1);
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n\nCHANGED\n');
    expect(planDigest(repo)).not.toBe(d1);
  });

  it('digests an absent plan.md to the empty string (never throws)', () => {
    expect(planDigest(repo)).toBe('');
  });
});
