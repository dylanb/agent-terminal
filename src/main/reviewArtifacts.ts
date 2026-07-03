// §26.4 / §26.3 D47a(b) — the reviewers turn's artifact-confirmed check: every roster persona has
// written a parseable review JSON for the current iteration. A missing or malformed one leaves the turn
// un-confirmed (the orchestrator retries, then errors) rather than advancing on a partial fan-out.

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Finding } from './findingSignature';

/** The path to one review artifact under `<repoDir>/.agent-loop/reviews/{iteration}/` (§26.3). */
function reviewPath(repoDir: string, iteration: number, name: string): string {
  return path.join(repoDir, '.agent-loop', 'reviews', String(iteration), name);
}

/** The raw string `verdict` from a review JSON, or null when absent / unparseable / carrying no string
 *  verdict. The caller normalizes the raw value against the LoopDef taxonomy (§26.6); never throws. */
function readVerdict(file: string): string | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (doc !== null && typeof doc === 'object' && typeof (doc as { verdict?: unknown }).verdict === 'string') {
      return (doc as { verdict: string }).verdict;
    }
    return null;
  } catch {
    return null;
  }
}

/** True iff every `persona` has a parseable `reviews/{iteration}/{persona}.json` under `<repoDir>/.agent-loop`.
 *  An absent or non-JSON file fails the check; vacuously true for an empty roster (the caller guards that). */
export function allReviewsPresent(repoDir: string, iteration: number, personas: string[]): boolean {
  return personas.every((persona) => isParseableJson(reviewPath(repoDir, iteration, `${persona}.json`)));
}

/** True iff `file` exists and parses as JSON (§26.4 artifact-confirmed check); false on any error. */
function isParseableJson(file: string): boolean {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** True iff AT LEAST ONE `persona` has a parseable `reviews/{iteration}/{persona}.json` (§26.11 resume).
 *  Because reviewers only run after the work turn completes for an iteration, one present review is
 *  iteration-scoped proof that iteration's work turn finished — unlike bare `plan.md` presence, which is
 *  not iteration-stamped. Vacuously false for an empty roster. */
export function anyReviewPresent(repoDir: string, iteration: number, personas: string[]): boolean {
  return personas.some((persona) => isParseableJson(reviewPath(repoDir, iteration, `${persona}.json`)));
}

/** The consolidate turn's artifact-confirmed check (§26.3/D47a b + §26.13 L4): the raw `verdict` string
 *  from `reviews/{iteration}/consolidated.json`, or null when the file is absent, does not parse, or
 *  carries no string verdict. The caller normalizes the raw value against the LoopDef taxonomy (§26.6). */
export function consolidatedVerdict(repoDir: string, iteration: number): string | null {
  return readVerdict(reviewPath(repoDir, iteration, 'consolidated.json'));
}

/** The kept findings from `reviews/{iteration}/consolidated.json` (§26.8 signature input): each entry's
 *  `severity` + `message`. An absent/malformed file, a missing `findings_kept`, or an entry lacking a
 *  string severity or message all degrade to (or drop from) an empty set — never throws. */
export function consolidatedFindings(repoDir: string, iteration: number): Finding[] {
  const file = reviewPath(repoDir, iteration, 'consolidated.json');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const kept = (doc as { findings_kept?: unknown }).findings_kept;
  if (!Array.isArray(kept)) return [];
  return kept
    .map((f): Finding | null =>
      f !== null && typeof f === 'object' && typeof (f as Finding).severity === 'string' && typeof (f as Finding).message === 'string'
        ? { severity: (f as Finding).severity, message: (f as Finding).message }
        : null,
    )
    .filter((f): f is Finding => f !== null);
}

/** The raw `verdict` string from one persona's `reviews/{iteration}/{persona}.json` (§26.5 skip-opt), or
 *  null when the file is absent, unparseable, or carries no string verdict. */
export function personaVerdict(repoDir: string, iteration: number, persona: string): string | null {
  return readVerdict(reviewPath(repoDir, iteration, `${persona}.json`));
}

/** The SHA256 digest of `.agent-loop/plan.md` — the plan-phase skip footprint (§26.5). "" when plan.md is
 *  absent/unreadable, so a persona is never pruned against a missing plan (never throws). */
export function planDigest(repoDir: string): string {
  try {
    return createHash('sha256').update(readFileSync(path.join(repoDir, '.agent-loop', 'plan.md'))).digest('hex');
  } catch {
    return '';
  }
}

/** Reuse each pruned persona's last-clean review (§26.5 skip-opt): copy `reviews/{fromIter}/{persona}.json`
 *  → `reviews/{toIter}/{persona}.json`, byte-for-byte. Best-effort per persona — a missing source is
 *  skipped, never thrown, so a partial prior fan-out cannot abort the reuse. */
export function carryForwardReviews(repoDir: string, personas: string[], fromIter: number, toIter: number): void {
  for (const persona of personas) {
    const from = reviewPath(repoDir, fromIter, `${persona}.json`);
    const to = reviewPath(repoDir, toIter, `${persona}.json`);
    try {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    } catch {
      // best-effort: a missing/unreadable source review is skipped
    }
  }
}
