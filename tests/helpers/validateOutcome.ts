// What a `--validate-flow` run printed and returned, reduced to the CLI contract's facts, for the e2e specs
// and the integration tests that call the validator directly.

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const ONE_LINE = /^[^\r\n]+\n?$/;

/** What a run printed and returned, for a failure diff. */
export function runText(result: RunResult): string {
  return `exit ${String(result.status)}${result.signal === null ? '' : ` (${result.signal})`}; stdout: ${JSON.stringify(result.stdout)}; stderr: ${JSON.stringify(result.stderr)}`;
}

/** A pass, reduced to the CLI contract's facts for one `toEqual(PASSED)` in the spec, so the failure is reported
 *  at the spec's own line, as an assertion, and its diff names every fact that is wrong. `output` is the whole run,
 *  for the diff only: every expectation accepts any text there. */
export function passOutcome(result: RunResult): { status: number | null; oneLine: boolean; okLine: boolean; output: string } {
  const oneLine = ONE_LINE.test(result.stdout);
  return { status: result.status, oneLine, okLine: oneLine && result.stdout.startsWith('OK: '), output: runText(result) };
}

/** A problem, reduced to the CLI contract's facts: the exit status, whether standard output is exactly one line,
 *  whether it starts with one of `paths` then ": ", and the problem text after that prefix (the whole output when
 *  no prefix matched). */
export function problemOutcome(
  result: RunResult,
  paths: string | readonly string[],
): { status: number | null; oneLine: boolean; prefixed: boolean; problem: string; output: string } {
  const line = result.stdout.replace(/\n$/, '');
  const prefix = [paths].flat().map((p) => `${p}: `).find((p) => line.startsWith(p));
  return {
    status: result.status,
    oneLine: ONE_LINE.test(result.stdout),
    prefixed: prefix !== undefined,
    problem: prefix === undefined ? line : line.slice(prefix.length),
    output: runText(result),
  };
}
