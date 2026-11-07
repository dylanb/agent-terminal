// §27.12 — the loop's own format checker, runnable by the agent before it signals done. The engine gates a
// review or consolidator turn on the shared predicates (roundReport.ts / consolidatorOutput.ts); this module
// hands the agent a command that runs those SAME predicates, so "I checked it" and "the engine accepts it"
// cannot disagree. The argv writer (artifactCheckCommand) and its reader (runArtifactCheck) live here together.

import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { roundReportProblems } from '../shared/roundReport';
import { consolidatorOutputProblems } from '../shared/consolidatorOutput';
import { goalLegEnd } from '../shared/goalProgress';
import { phaseOutputRel, phaseResultEnd, type PhaseResultWant } from '../shared/phaseResult';
import { isPhaseOutcome } from '../shared/phaseOutcome';
import { isBuildOutcome, type BuildOutcome } from '../shared/buildOutcome';
import { LOOP_CAPABILITIES_FILENAME } from '../shared/loopCapabilities';
import type { LoopCapabilitiesLoad } from './loopCapabilities';

/** What to check: a round report against its sections + roster, a consolidator verdict against its catalog, a
 *  goal session's progress file against the leg it is on (§27.3), a phase result against what completes its
 *  phase (§28.5.3), or the repository's `loop-capabilities.yaml` against the app's reader (§29). */
export type ArtifactCheck =
  | { kind: 'report'; rel: string; sections: string[]; roster: string[] }
  | { kind: 'verdict'; rel: string; catalog: string[] }
  | { kind: 'progress'; rel: string; leg: number; legs: boolean }
  | ({ kind: 'result'; rel: string } & PhaseResultWant)
  | { kind: 'capabilities' };

/** What a check reads: a file by its repo-relative path (null = missing), and the repository's capabilities
 *  through the app's own reader. */
export interface ArtifactCheckInputs {
  read(rel: string): string | null;
  loadCapabilities(): LoopCapabilitiesLoad;
}

const IN_LEGS = 'legs';
const ONE_LEG = 'one-leg';
const NO_BUILD = 'no-build';
const VERIFICATION_ONLY = 'verification-only';
const CAPABILITIES = 'capabilities';

/** The rollup entry name the build emits the checker under, and the basename the runtime resolves it by. */
export const ARTIFACT_CHECK_ENTRY = 'artifactCheck';

/** The line the checker prints when the file passes. */
export const ARTIFACT_CHECK_PASSED = 'OK';

/** How to run the bundled checker: the app binary in plain-Node mode, and the checker script beside main. */
export interface ArtifactCheckRuntime {
  execPath: string;
  script: string;
}

/** The checker script's path, beside the main bundle that the build emits it next to. */
export function resolveArtifactCheckScript(mainDir: string): string {
  return path.join(mainDir, `${ARTIFACT_CHECK_ENTRY}.js`);
}

const csv = (items: string[]): string => items.join(',');
const fromCsv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function checkArgv(check: ArtifactCheck): string[] {
  switch (check.kind) {
    case 'report':
      return ['report', check.rel, csv(check.sections), csv(check.roster)];
    case 'verdict':
      return ['verdict', check.rel, csv(check.catalog)];
    case 'progress':
      return ['progress', check.rel, String(check.leg), check.legs ? IN_LEGS : ONE_LEG];
    case 'result':
      return ['result', check.rel, check.outcome, check.build ?? NO_BUILD, ...(check.acceptsVerificationOnly ? [VERIFICATION_ONLY] : [])];
    case 'capabilities':
      return [CAPABILITIES];
  }
}

function progressProblems(content: string, leg: string, legs: string): string[] | null {
  const n = Number(leg);
  if (!Number.isInteger(n) || n < 1 || (legs !== IN_LEGS && legs !== ONE_LEG)) return null;
  const end = goalLegEnd(content, { leg: n, legs: legs === IN_LEGS });
  return end.ok ? [] : [end.problem];
}

function resultProblems(rel: string, content: string, captured: string | null, [outcome, build, verification]: string[]): string[] | null {
  if (!isPhaseOutcome(outcome) || (build !== NO_BUILD && !isBuildOutcome(build))) return null;
  if (verification !== undefined && verification !== VERIFICATION_ONLY) return null;
  const want: PhaseResultWant = {
    outcome,
    ...(build !== NO_BUILD ? { build: build as BuildOutcome } : {}),
    ...(verification === VERIFICATION_ONLY ? { acceptsVerificationOnly: true as const } : {}),
  };
  const end = phaseResultEnd({ result: content, captured, capturedRel: phaseOutputRel(rel) }, want);
  return end.ok ? [] : [end.problem];
}

/** The shell command line the agent runs from the repo root to check `check`'s file (CWE-78: every operand
 *  is quoted through the shared primitive). */
export function artifactCheckCommand(runtime: ArtifactCheckRuntime, check: ArtifactCheck): string {
  return ['ELECTRON_RUN_AS_NODE=1', ...[runtime.execPath, runtime.script, ...checkArgv(check)].map(shellQuote)].join(' ');
}

const USAGE = `usage: report <file> <sections,...> <personas,...> | verdict <file> <catalog,...> | progress <file> <leg> <${IN_LEGS}|${ONE_LEG}> | result <file> <outcome> <build|${NO_BUILD}> [${VERIFICATION_ONLY}] | ${CAPABILITIES}\n`;

/** Run the check `argv` describes against the file `read` returns (null = missing), or — `capabilities` — the
 *  repository's capabilities through the app's reader. Exit 0 prints
 *  ARTIFACT_CHECK_PASSED; exit 1 lists each problem; exit 2 is a usage error. */
export function runArtifactCheck(argv: string[], { read, loadCapabilities }: ArtifactCheckInputs): { exitCode: 0 | 1 | 2; output: string } {
  const [kind, rel, ...rest] = argv;
  if (kind === CAPABILITIES && argv.length === 1) {
    const load = loadCapabilities();
    if (load.ok) return { exitCode: 0, output: `${ARTIFACT_CHECK_PASSED}: ${LOOP_CAPABILITIES_FILENAME} passes the app's reader\n` };
    return { exitCode: 1, output: `${LOOP_CAPABILITIES_FILENAME} fails the app's reader:\n- ${load.reason}\n` };
  }
  let problems: string[];
  if (kind === 'report' && rel !== undefined && rest.length === 2) {
    const content = read(rel);
    problems = content === null ? [`${rel} does not exist`] : roundReportProblems(content, { sections: fromCsv(rest[0]), roster: fromCsv(rest[1]) });
  } else if (kind === 'verdict' && rel !== undefined && rest.length === 1) {
    const content = read(rel);
    problems = content === null ? [`${rel} does not exist`] : consolidatorOutputProblems(content, fromCsv(rest[0]));
  } else if (kind === 'progress' && rel !== undefined && rest.length === 2) {
    const content = read(rel);
    const found = content === null ? [`${rel} does not exist`] : progressProblems(content, rest[0], rest[1]);
    if (found === null) return { exitCode: 2, output: USAGE };
    problems = found;
  } else if (kind === 'result' && rel !== undefined && (rest.length === 2 || rest.length === 3)) {
    const content = read(rel);
    const found = content === null ? [`${rel} does not exist`] : resultProblems(rel, content, read(phaseOutputRel(rel)), rest);
    if (found === null) return { exitCode: 2, output: USAGE };
    problems = found;
  } else {
    return { exitCode: 2, output: USAGE };
  }
  if (problems.length === 0) return { exitCode: 0, output: `${ARTIFACT_CHECK_PASSED}: ${rel} passes the loop's format check\n` };
  return { exitCode: 1, output: `${rel} fails the loop's format check:\n${problems.map((p) => `- ${p}`).join('\n')}\n` };
}

/** §27.12 — tell the agent to run the loop's own checker and fix the file until it passes, before `before`. */
export function checkerLines(checkCommand: string, what: string, before = 'writing the done-signal'): string[] {
  return [
    '',
    `Before ${before}, run the loop's own format check on the ${what} from the repo root and fix`,
    `the ${what} until it prints \`${ARTIFACT_CHECK_PASSED}\` — the loop accepts the turn only when this check passes:`,
    '',
    `    ${checkCommand}`,
  ];
}
