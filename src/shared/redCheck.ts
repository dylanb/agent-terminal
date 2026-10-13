// §28.5.2/§28.5.3 — the writer (the RED prompts) and the reader (the RED gate) of the red-check report share this
// module; a second copy of either would let the prompt and the gate disagree (CLAUDE.md shared semantics).

import { PHASE_RESULT_GRAMMAR } from './phaseResult';

export const INTENDED_FAILURES_HEADING = '## intended failures';
export const RED_CHECK_REPORT_VERSION = 1;
export const MAX_RED_CHECK_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_TESTS = 50_000;

export const RED_CHECK_TEST_OUTCOMES = ['passed', 'failed-assertion', 'errored', 'skipped'] as const;
export type RedCheckTestOutcome = (typeof RED_CHECK_TEST_OUTCOMES)[number];

export interface RedCheckFailure {
  line: number;
  message: string;
}

export interface RedCheckTest {
  /** Repo-relative, `/`-separated — the same form the RED gate's added-test paths take. */
  file: string;
  name: string;
  outcome: RedCheckTestOutcome;
  failures: RedCheckFailure[];
}

export interface RedCheckReport {
  tests: RedCheckTest[];
}

export interface IntendedFailure {
  file: string;
  line: number;
}

export type RedCheckVerdict = { ok: true; unchecked: string[] } | { ok: false; reason: string };

/** §28.5.2 — the round report carries this verbatim when the repo declares no `red_check_command`. */
export const RED_CHECK_MISSING_WARNING =
  'Warning: this RED was not independently checked — loop-capabilities.yaml declares no `red_check_command`, so whether each test fails at its own check rests on the agent\'s classification alone.';

const OUTCOME_SET: ReadonlySet<string> = new Set(RED_CHECK_TEST_OUTCOMES);

class ReportError extends Error {}
function fail(reason: string): never {
  throw new ReportError(reason);
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function requireTest(v: unknown, i: number): RedCheckTest {
  if (!isRecord(v)) fail(`tests[${i}] is not an object`);
  const { file, name, outcome, failures } = v;
  if (typeof file !== 'string' || file === '' || hasControlChar(file)) fail(`tests[${i}].file must be a plain non-empty path`);
  if (typeof name !== 'string' || hasControlChar(name)) fail(`tests[${i}].name must be a single-line string`);
  if (typeof outcome !== 'string' || !OUTCOME_SET.has(outcome)) fail(`tests[${i}].outcome must be one of ${RED_CHECK_TEST_OUTCOMES.join(', ')}`);
  if (!Array.isArray(failures)) fail(`tests[${i}].failures must be an array`);
  const parsedFailures = failures.map((f, j): RedCheckFailure => {
    if (!isRecord(f) || !isPositiveInt(f.line) || typeof f.message !== 'string') {
      fail(`tests[${i}].failures[${j}] must carry a positive integer line and a message`);
    }
    return { line: f.line, message: f.message };
  });
  if (outcome === 'failed-assertion' && parsedFailures.length === 0) fail(`tests[${i}] failed by assertion but names no failure location`);
  return { file, name, outcome: outcome as RedCheckTestOutcome, failures: parsedFailures };
}

export function parseRedCheckReport(text: string): { ok: true; report: RedCheckReport } | { ok: false; reason: string } {
  try {
    if (new TextEncoder().encode(text).length > MAX_RED_CHECK_REPORT_BYTES) fail('the report is too large');
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      fail('the report is not JSON');
    }
    if (!isRecord(doc)) fail('the report must be a JSON object');
    if (doc.version !== RED_CHECK_REPORT_VERSION) fail(`the report version must be ${RED_CHECK_REPORT_VERSION}`);
    if (!Array.isArray(doc.tests)) fail('the report has no tests array');
    if (doc.tests.length > MAX_TESTS) fail(`the report lists more than ${MAX_TESTS} tests`);
    return { ok: true, report: { tests: doc.tests.map(requireTest) } };
  } catch (e) {
    if (e instanceof ReportError) return { ok: false, reason: e.message };
    throw e;
  }
}

export function parseIntendedFailures(text: string): { ok: true; intended: IntendedFailure[] } | { ok: false; reason: string } {
  const lines = text.split('\n');
  const intended: IntendedFailure[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === PHASE_RESULT_GRAMMAR.capturedOutputHeading) break;
    if (line.startsWith('#')) {
      inSection = line === INTENDED_FAILURES_HEADING;
      continue;
    }
    if (!inSection || line === '') continue;
    if (!line.startsWith('- ')) return { ok: false, reason: `an intended failure must be a \`- file:line\` entry: ${line}` };
    const entry = line.slice(2).trim();
    const colon = entry.lastIndexOf(':');
    const file = colon > 0 ? entry.slice(0, colon) : '';
    const lineText = colon > 0 ? entry.slice(colon + 1) : '';
    const n = Number(lineText);
    if (file === '' || hasControlChar(file) || lineText === '' || !isPositiveInt(n)) {
      return { ok: false, reason: `an intended failure must be a \`- file:line\` entry: ${line}` };
    }
    intended.push({ file, line: n });
  }
  return { ok: true, intended };
}

const loc = (file: string, line: number): string => `${file}:${line}`;

/** §28.5.3 */
export function redCheckVerdict(q: { report: RedCheckReport; intended: IntendedFailure[]; addedTestPaths: string[] }): RedCheckVerdict {
  if (q.intended.length === 0) {
    return { ok: false, reason: `the RED result declares no intended failures under \`${INTENDED_FAILURES_HEADING}\`` };
  }
  const added = new Set(q.addedTestPaths);
  const problems: string[] = [];
  const observed = new Set<string>();
  for (const t of q.report.tests) {
    if (!added.has(t.file)) continue;
    if (t.outcome === 'errored') problems.push(`${t.file} › ${t.name} errored instead of failing by assertion`);
    if (t.outcome === 'failed-assertion') for (const f of t.failures) observed.add(loc(t.file, f.line));
  }
  const covered = new Set(q.report.tests.map((t) => t.file));
  const unchecked = [...new Set(q.intended.filter((i) => !covered.has(i.file)).map((i) => i.file))].sort();
  const declared = new Set(q.intended.filter((i) => covered.has(i.file)).map((i) => loc(i.file, i.line)));
  for (const d of declared) if (!observed.has(d)) problems.push(`${d} is declared but did not fail by assertion`);
  for (const o of observed) if (!declared.has(o)) problems.push(`${o} failed but is not a declared intended failure`);
  return problems.length === 0 ? { ok: true, unchecked } : { ok: false, reason: `the RED check refused: ${problems.join('; ')}` };
}

export function redCheckReportRel(resultRel: string): string {
  const cut = resultRel.lastIndexOf('/');
  const dot = resultRel.lastIndexOf('.');
  const stem = dot > cut + 1 ? resultRel.slice(0, dot) : resultRel;
  return `${stem}.check.json`;
}

export function exampleRedCheckReport(): string {
  return JSON.stringify(
    {
      version: RED_CHECK_REPORT_VERSION,
      tests: [
        { file: 'tests/adder.test.ts', name: 'adds two numbers', outcome: 'failed-assertion', failures: [{ line: 5, message: 'AssertionError: expected 2 to be 3' }] },
      ],
    },
    null,
    2,
  );
}

export function exampleIntendedFailures(): string[] {
  return ['- tests/adder.test.ts:5'];
}

/** §28.5.3 */
export function composeRedCheckInstruction(opts: { command: string; reportRel: string; resultRel: string }): string[] {
  return [
    `After the test run, run the repository's RED check, \`${opts.command}\`, with the test files you added or`,
    `changed as its arguments, and save what it prints to ${opts.reportRel}. Run it again after any later edit to`,
    'those tests, so the report is never older than them. Then list every check you intend to fail, one per line',
    `as \`- file:line\` (repo-relative), under a \`${INTENDED_FAILURES_HEADING}\` heading in ${opts.resultRel},`,
    `placed before the \`${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\` heading. The engine passes this RED only when,`,
    'in the files you added tests to, nothing errored and the checks that failed are exactly the ones listed.',
    'A test file the check does not run never appears in its report: still declare its intended failures, and the',
    'run log records them as not independently checked.',
    'A test that fails before it reaches the check it exists for is not fixed by listing that earlier line: restructure',
    'it so its own check is the one that fails — split it, or use soft assertions so every check reports.',
    'An example report and the matching declaration:',
    '',
    '```',
    exampleRedCheckReport(),
    '```',
    '',
    INTENDED_FAILURES_HEADING,
    '',
    ...exampleIntendedFailures(),
  ];
}
