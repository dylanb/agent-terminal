// §27.12 — the loop's own format checker, runnable by the agent before it signals done. The engine gates a
// review or consolidator turn on the shared predicates (roundReport.ts / consolidatorOutput.ts); this module
// hands the agent a command that runs those SAME predicates, so "I checked it" and "the engine accepts it"
// cannot disagree. The argv writer (artifactCheckCommand) and its reader (runArtifactCheck) live here together.

import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { roundReportProblems } from '../shared/roundReport';
import { consolidatorOutputProblems } from '../shared/consolidatorOutput';

/** What to check: a round report against its sections + roster, or a consolidator verdict against its catalog. */
export type ArtifactCheck =
  | { kind: 'report'; rel: string; sections: string[]; roster: string[] }
  | { kind: 'verdict'; rel: string; catalog: string[] };

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
  return check.kind === 'report'
    ? ['report', check.rel, csv(check.sections), csv(check.roster)]
    : ['verdict', check.rel, csv(check.catalog)];
}

/** The shell command line the agent runs from the repo root to check `check`'s file (CWE-78: every operand
 *  is quoted through the shared primitive). */
export function artifactCheckCommand(runtime: ArtifactCheckRuntime, check: ArtifactCheck): string {
  return ['ELECTRON_RUN_AS_NODE=1', ...[runtime.execPath, runtime.script, ...checkArgv(check)].map(shellQuote)].join(' ');
}

/** Run the check `argv` describes against the file `read` returns (null = missing). Exit 0 prints
 *  ARTIFACT_CHECK_PASSED; exit 1 lists each problem; exit 2 is a usage error. */
export function runArtifactCheck(argv: string[], read: (rel: string) => string | null): { exitCode: 0 | 1 | 2; output: string } {
  const [kind, rel, ...rest] = argv;
  let problems: string[];
  if (kind === 'report' && rel !== undefined && rest.length === 2) {
    const content = read(rel);
    problems = content === null ? [`${rel} does not exist`] : roundReportProblems(content, { sections: fromCsv(rest[0]), roster: fromCsv(rest[1]) });
  } else if (kind === 'verdict' && rel !== undefined && rest.length === 1) {
    const content = read(rel);
    problems = content === null ? [`${rel} does not exist`] : consolidatorOutputProblems(content, fromCsv(rest[0]));
  } else {
    return { exitCode: 2, output: 'usage: report <file> <sections,...> <personas,...> | verdict <file> <catalog,...>\n' };
  }
  if (problems.length === 0) return { exitCode: 0, output: `${ARTIFACT_CHECK_PASSED}: ${rel} passes the loop's format check\n` };
  return { exitCode: 1, output: `${rel} fails the loop's format check:\n${problems.map((p) => `- ${p}`).join('\n')}\n` };
}
