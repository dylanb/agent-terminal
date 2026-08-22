// §28.5.5 — the phase-result file grammar: a serialized vocabulary with ONE writer (the RED work recipe/prompt)
// and ONE predicate (the RED completion gate). Single-sourced here so the prompt that tells the agent what to
// write and the predicate that validates it cannot drift — the structural twin of roundReport.ts. The outcome
// vocabulary is phaseOutcome's, imported, never re-spelled. Two required elements: the agent's classification
// (`outcome:`) and the raw captured run (`## captured output`, AC3) — the classification PRECEDES its evidence
// so the free-form raw body (which may itself contain a look-alike line) is never read as the classification.
// The predicate validates the MINIMAL contract (§28.5.5), never a rigid layout. Parsing is a plain linear scan
// (no RegExp) — the linear-time guarantee on untrusted agent output is load-bearing (CWE-1333/400).

import { isPhaseOutcome, type PhaseOutcome } from './phaseOutcome';
import { isBuildOutcome, type BuildOutcome } from './buildOutcome';
import { fieldValue } from './markdownFields';

export interface PhaseResultGrammar {
  outcomeLabel: string;
  /** §28.5.3 — the GREEN turn's second classification field: the build command's outcome (buildOutcome). Parsed
   *  exactly like `outcome` but OPTIONAL at the grammar level — a RED result carries no build line and stays
   *  well-formed; the GREEN gate (not the grammar) requires `build: built`. */
  buildLabel: string;
  capturedOutputHeading: string;
}

export const PHASE_RESULT_GRAMMAR: PhaseResultGrammar = {
  outcomeLabel: 'outcome',
  buildLabel: 'build',
  capturedOutputHeading: '## captured output',
};

export interface ParsedPhaseResult {
  /** The classified outcome when it is a member of the closed set (exact, trimmed, never normalized); else null. */
  outcome: PhaseOutcome | null;
  /** §28.5.3 — the classified build outcome when present AND a member of BUILD_OUTCOMES (exact, trimmed, never
   *  normalized); null when the line is absent or an unknown spelling. Read only from BEFORE the captured-output
   *  heading, like `outcome`, so a look-alike line in the raw body is never mistaken for it. */
  build: BuildOutcome | null;
  /** The raw captured run under the heading (trimmed), or null when the section is absent or empty. */
  capturedOutput: string | null;
}

/** Parse the two contract elements. The captured-output section is everything from its heading to EOF (raw
 *  test output is free-form — `#` lines and code fences inside it are preserved); the outcome field is read only
 *  from BEFORE that heading. */
export function parsePhaseResult(text: string): ParsedPhaseResult {
  const lines = text.split('\n');

  // The captured-output heading: trim-then-exact match (surrounding whitespace tolerated; wrong case / missing
  // space are NOT this heading).
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === PHASE_RESULT_GRAMMAR.capturedOutputHeading) {
      headingIdx = i;
      break;
    }
  }

  const outcomeScanEnd = headingIdx === -1 ? lines.length : headingIdx;
  let outcome: PhaseOutcome | null = null;
  let build: BuildOutcome | null = null;
  for (let i = 0; i < outcomeScanEnd; i++) {
    if (outcome === null) {
      const v = fieldValue(lines[i], PHASE_RESULT_GRAMMAR.outcomeLabel);
      if (v !== null) {
        outcome = isPhaseOutcome(v) ? v : null; // exact, trimmed, never normalized — an unknown spelling is null
        continue;
      }
    }
    if (build === null) {
      const b = fieldValue(lines[i], PHASE_RESULT_GRAMMAR.buildLabel);
      if (b !== null) build = isBuildOutcome(b) ? b : null; // same exact/never-normalized rule as outcome
    }
  }

  let capturedOutput: string | null = null;
  if (headingIdx !== -1) {
    const body = lines.slice(headingIdx + 1).join('\n').trim();
    capturedOutput = body.length > 0 ? body : null;
  }

  return { outcome, build, capturedOutput };
}

/** Well-formed ⟺ a classified outcome from the closed set AND a non-empty captured-output section (AC3). Shape
 *  and vocabulary membership only — the `outcome === 'failed-assertion'` RED decision is the gate's, not the
 *  grammar's (the grammar is phase-agnostic; S4's GREEN turn reuses it wanting `passed`). */
export function phaseResultWellFormed(text: string): boolean {
  const { outcome, capturedOutput } = parsePhaseResult(text);
  return outcome !== null && capturedOutput !== null;
}

// A plausible raw run per outcome, so the canonical example is a usable few-shot for the prompt. The grammar
// never validates this CONTENT (only its presence) — the categories map onto any framework (§28.5.2).
const SAMPLE_CAPTURED: Record<PhaseOutcome, string> = {
  passed: '$ pnpm test\n ✓ src/adder.test.ts (3 tests)\n Test Files  1 passed (1)',
  'failed-assertion':
    '$ pnpm test\n × src/adder.test.ts > adds two numbers\n   AssertionError: expected 2 to be 3\n   - Expected\n   + Received',
  errored: "$ pnpm test\n Error: Cannot find module './adder'\n     at src/adder.test.ts:1:1\n (no tests ran)",
  'no-tests-selected': '$ pnpm test -- src/does-not-exist\n No test files found, exiting with code 1',
};

/** The ONE canonical example the predicate happy-path test, the fake-agent e2e output, and the prompt few-shot
 *  reference — one artifact so the consumers cannot drift (§28.5.5). One per outcome so any can be scripted. With
 *  `opts.build` it emits the GREEN turn's `build:` line (§28.5.3) directly after `outcome:` and before the
 *  captured-output heading; without it the RED shape is byte-for-byte unchanged (a RED result carries no build
 *  line). The captured output carries NO ``` fence: this same string is embedded inside a prompt's own fenced
 *  few-shot (§28 §7d), where an inner fence would close the outer one early (as exampleRoundReport also avoids). */
export function examplePhaseResult(outcome: PhaseOutcome, opts?: { build?: BuildOutcome }): string {
  const g = PHASE_RESULT_GRAMMAR;
  return [
    '# Phase result',
    '',
    `${g.outcomeLabel}: ${outcome}`,
    ...(opts?.build !== undefined ? [`${g.buildLabel}: ${opts.build}`] : []),
    '',
    g.capturedOutputHeading,
    '',
    SAMPLE_CAPTURED[outcome],
    '',
  ].join('\n');
}
