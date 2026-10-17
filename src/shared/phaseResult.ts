// §28.5.5 — the phase result: JSON with ONE writer (the RED/GREEN/refactor prompt) and the readers that gate on
// it (the completion gate, the agent's own check, the RED check). Single-sourced here so the prompt that tells the
// agent what to write and the predicate that judges it cannot drift. The outcome vocabulary is phaseOutcome's,
// imported, never re-spelled. The raw test run is evidence, not data: it is kept verbatim in a file of its own
// beside the result, which the predicate requires to be present and non-empty but never reads.

import { PHASE_OUTCOMES, type PhaseOutcome } from './phaseOutcome';
import { BUILD_OUTCOMES, type BuildOutcome } from './buildOutcome';

/** The JSON keys of the result. */
export const PHASE_RESULT_FIELDS = {
  outcome: 'outcome',
  build: 'build',
  intendedFailures: 'intendedFailures',
} as const;

/** A check a RED test is meant to fail at (§28.5.3): repo-relative, `/`-separated, and its 1-based line. */
export interface IntendedFailure {
  file: string;
  line: number;
}

export interface PhaseResult {
  outcome: PhaseOutcome;
  /** §28.5.3 — the GREEN turn's build classification; null when the result carries none. */
  build: BuildOutcome | null;
  /** §28.5.3 — the RED result's declared failure locations; null when the result declares none. */
  intendedFailures: IntendedFailure[] | null;
}

export type PhaseResultRead = { ok: true; result: PhaseResult } | { ok: false; problem: string };

const BYTE_ORDER_MARK = '﻿';
const OUTCOME_SET: ReadonlySet<string> = new Set(PHASE_OUTCOMES);
const BUILD_SET: ReadonlySet<string> = new Set(BUILD_OUTCOMES);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function intendedFailure(v: unknown): IntendedFailure | null {
  if (!isRecord(v)) return null;
  const { file, line } = v;
  if (typeof file !== 'string' || file === '' || hasControlChar(file)) return null;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  return { file, line };
}

/** The phase result read, or what is wrong with it. The problem is fixed text, never the file's own. */
export function readPhaseResult(text: string): PhaseResultRead {
  const f = PHASE_RESULT_FIELDS;
  let doc: unknown;
  try {
    doc = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text);
  } catch {
    return { ok: false, problem: 'it is not valid JSON' };
  }
  if (!isRecord(doc)) return { ok: false, problem: 'it is not a JSON object' };
  const outcome = doc[f.outcome];
  if (typeof outcome !== 'string' || !OUTCOME_SET.has(outcome)) {
    return { ok: false, problem: `its "${f.outcome}" is not one of ${PHASE_OUTCOMES.join(', ')}` };
  }
  const build = doc[f.build] ?? null;
  if (build !== null && (typeof build !== 'string' || !BUILD_SET.has(build))) {
    return { ok: false, problem: `its "${f.build}" is not one of ${BUILD_OUTCOMES.join(', ')}` };
  }
  const declared = doc[f.intendedFailures] ?? null;
  let intendedFailures: IntendedFailure[] | null = null;
  if (declared !== null) {
    const entries = Array.isArray(declared) ? declared.map(intendedFailure) : [null];
    if (entries.some((e) => e === null)) {
      return { ok: false, problem: `its "${f.intendedFailures}" is not a list of {"file", "line"} entries, each a repo-relative path and a positive whole line number` };
    }
    intendedFailures = entries as IntendedFailure[];
  }
  return { ok: true, result: { outcome: outcome as PhaseOutcome, build: build as BuildOutcome | null, intendedFailures } };
}

/** Where a phase result's raw captured run is kept: beside it, its extension replaced by `.output.txt`. */
export function phaseOutputRel(resultRel: string): string {
  const cut = resultRel.lastIndexOf('/');
  const dot = resultRel.lastIndexOf('.');
  const stem = dot > cut + 1 ? resultRel.slice(0, dot) : resultRel;
  return `${stem}.output.txt`;
}

/** Whether a phase result completes its turn (§28.5.3): well-formed, the outcome the phase wants (and, for GREEN,
 *  the build it wants), with its captured run present and non-empty. The engine at the done-signal and the
 *  agent's own check both decide by this. */
export function phaseResultEnd(
  files: { result: string; captured: string | null; capturedRel: string },
  want: { outcome: PhaseOutcome; build?: BuildOutcome },
): PhaseResultRead {
  const read = readPhaseResult(files.result);
  if (!read.ok) return { ok: false, problem: `it is not well-formed: ${read.problem}` };
  const { outcome, build } = read.result;
  if (outcome !== want.outcome) return { ok: false, problem: `it reports ${outcome}, not ${want.outcome}` };
  if (want.build !== undefined && build !== want.build) {
    return { ok: false, problem: `it reports ${build === null ? 'no build' : `build ${build}`}, not ${want.build}` };
  }
  if (files.captured === null) return { ok: false, problem: `its captured run ${files.capturedRel} is missing` };
  if (files.captured.trim() === '') return { ok: false, problem: `its captured run ${files.capturedRel} is empty` };
  return read;
}

// A plausible raw run per outcome, so the prompt can show what belongs in the captured-run file. Nothing ever
// validates this content (only its presence) — the categories map onto any framework (§28.5.2).
const SAMPLE_CAPTURED: Record<PhaseOutcome, string> = {
  passed: '$ pnpm test\n ✓ src/adder.test.ts (3 tests)\n Test Files  1 passed (1)',
  'failed-assertion':
    '$ pnpm test\n × src/adder.test.ts > adds two numbers\n   AssertionError: expected 2 to be 3\n   - Expected\n   + Received',
  errored: "$ pnpm test\n Error: Cannot find module './adder'\n     at src/adder.test.ts:1:1\n (no tests ran)",
  'no-tests-selected': '$ pnpm test -- src/does-not-exist\n No test files found, exiting with code 1',
};

export function exampleCapturedOutput(outcome: PhaseOutcome): string {
  return `${SAMPLE_CAPTURED[outcome]}\n`;
}

/** The ONE canonical example the predicate test, the fake-agent e2e output and the prompt few-shot reference
 *  (§28.5.5), one per outcome so any can be scripted; `opts` adds GREEN's build or RED's intended failures. */
export function examplePhaseResult(outcome: PhaseOutcome, opts?: { build?: BuildOutcome; intendedFailures?: IntendedFailure[] }): string {
  const f = PHASE_RESULT_FIELDS;
  return `${JSON.stringify(
    {
      [f.outcome]: outcome,
      ...(opts?.build !== undefined ? { [f.build]: opts.build } : {}),
      ...(opts?.intendedFailures !== undefined ? { [f.intendedFailures]: opts.intendedFailures } : {}),
    },
    null,
    2,
  )}\n`;
}

/** §28.5.5 / §28 §7d — the phase-result WRITER instruction, single-sourced here so it cannot drift from the
 *  predicate that gates the file it instructs the agent to write. */
export function composePhaseResultInstruction(opts: {
  resultRel: string;
  completingOutcome: PhaseOutcome;
  build?: { completingBuildOutcome: BuildOutcome };
  closing: string[];
}): string[] {
  const f = PHASE_RESULT_FIELDS;
  const outputRel = phaseOutputRel(opts.resultRel);
  const lines: string[] = [
    `Run the test command for this change and save its raw output verbatim, exactly as it printed, to ${outputRel}`,
    `(for example by redirecting the command's output there). Classify that run as EXACTLY one of: ${PHASE_OUTCOMES.join(', ')}.`,
  ];
  if (opts.build !== undefined) {
    lines.push(`Then run the build command and classify it as EXACTLY one of: ${BUILD_OUTCOMES.join(', ')}.`);
  }
  lines.push(
    `Write the classification to ${opts.resultRel} as a JSON object: \`"${f.outcome}"\` for the test run${
      opts.build !== undefined ? `, and \`"${f.build}"\` for the build` : ''
    }. The run itself stays in ${outputRel}, never in the JSON. For example:`,
    '',
    examplePhaseResult(opts.completingOutcome, opts.build ? { build: opts.build.completingBuildOutcome } : undefined).trimEnd(),
    '',
    ...opts.closing,
  );
  return lines;
}
