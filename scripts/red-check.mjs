// §28.5.2

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const SPEC_ARG = /^(.*\.spec\.ts)((?::\d+)+)?$/;
const TEST_DECLARATION = /^\s*test(?:\.(?:only|fail|fixme|skip|slow))?\s*\(/;

const args = process.argv.slice(2);
const specArgs = args.filter((a) => SPEC_ARG.test(a));
const vitestArgs = args.filter((a) => !SPEC_ARG.test(a));

const tests = [];
let ok = true;
if (vitestArgs.length > 0 || specArgs.length === 0) {
  const run = runVitest(vitestArgs);
  if (run === null) {
    process.stderr.write('red-check: vitest produced no JSON report\n');
    process.exitCode = 1;
    ok = false;
  } else {
    tests.push(...vitestReport(run));
  }
}
if (ok && specArgs.length > 0) tests.push(...runPlaywright(specArgs));
if (ok) process.stdout.write(`${JSON.stringify({ version: 1, tests }, null, 2)}\n`);

function rel(abs) {
  return path.relative(process.cwd(), abs).split(path.sep).join('/');
}

function controlFree(s) {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function runVitest(vitestArgs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'red-check-'));
  const out = path.join(dir, 'vitest.json');
  try {
    spawnSync(process.execPath, [vitestBin, 'run', '--reporter=json', `--outputFile=${out}`, ...vitestArgs], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
      return JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      return null;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function vitestReport(run) {
  const lineIn = (message, abs) => {
    const at = message.indexOf(`${abs}:`);
    if (at === -1) return null;
    const n = Number.parseInt(message.slice(at + abs.length + 1), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const isAssertion = (message) => message.startsWith('AssertionError');

  const tests = [];
  for (const file of run.testResults) {
    if (file.assertionResults.length === 0 && file.status === 'failed') {
      tests.push({ file: rel(file.name), name: '', outcome: 'errored', failures: [] });
      continue;
    }
    for (const t of file.assertionResults) {
      const name = controlFree([...t.ancestorTitles, t.title].join(' > '));
      if (t.status === 'passed') {
        tests.push({ file: rel(file.name), name, outcome: 'passed', failures: [] });
        continue;
      }
      if (t.status !== 'failed') {
        tests.push({ file: rel(file.name), name, outcome: 'skipped', failures: [] });
        continue;
      }
      const failures = t.failureMessages.map((m) => ({ line: lineIn(m, file.name), message: m.split('\n')[0], assertion: isAssertion(m) }));
      const located = failures.every((f) => f.line !== null);
      const outcome = located && failures.length > 0 && failures.every((f) => f.assertion) ? 'failed-assertion' : 'errored';
      tests.push({
        file: rel(file.name),
        name,
        outcome,
        failures: failures.filter((f) => f.line !== null).map((f) => ({ line: f.line, message: f.message })),
      });
    }
  }
  return tests;
}

function git(...gitArgs) {
  return spawnSync('git', gitArgs, { encoding: 'utf8' });
}

/** The Playwright selectors for the tests a RED added or changed in `file`: each changed line's enclosing test
 *  declaration (`file:line`), the whole file when git does not track it, nothing when it is unchanged. */
function changedTestSelectors(file) {
  if (git('ls-files', '--error-unmatch', '--', file).status !== 0) return [file];
  const diff = git('diff', '--unified=0', 'HEAD', '--', file).stdout;
  const changed = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) changed.push(Math.max(start, 1));
    for (let i = 0; i < count; i++) changed.push(start + i);
  }
  if (changed.length === 0) return [];
  const source = readFileSync(file, 'utf8').split('\n');
  const declarations = source.flatMap((text, i) => (TEST_DECLARATION.test(text) ? [i + 1] : []));
  const enclosing = new Set();
  for (const line of changed) {
    if ((source[line - 1] ?? '').trim() === '') continue;
    const decl = declarations.filter((d) => d <= line).at(-1);
    if (decl !== undefined) enclosing.add(decl);
  }
  return [...enclosing].sort((a, b) => a - b).map((d) => `${file}:${d}`);
}

function runPlaywright(specArgs) {
  const selectors = specArgs.flatMap((a) => (SPEC_ARG.exec(a)[2] === undefined ? changedTestSelectors(a) : [a]));
  if (selectors.length === 0) return [];
  const files = [...new Set(selectors.map((s) => SPEC_ARG.exec(s)[1]))];
  const parent = path.join(process.cwd(), '.agent-terminal');
  mkdirSync(parent, { recursive: true });
  const io = mkdtempSync(path.join(parent, 'red-check-'));
  try {
    writeFileSync(path.join(io, 'select.txt'), `${selectors.join('\n')}\n`);
    const runner = process.env.RED_CHECK_E2E_RUNNER ?? path.join(here, 'e2e-podman.sh');
    spawnSync(runner, [], { stdio: ['ignore', 2, 'inherit'], env: { ...process.env, E2E_IO_DIR: rel(io) } });
    let run;
    try {
      run = JSON.parse(readFileSync(path.join(io, 'report.json'), 'utf8'));
    } catch {
      process.stderr.write('red-check: the e2e run produced no Playwright JSON report\n');
      return files.map((file) => ({ file, name: 'the e2e run produced no report', outcome: 'errored', failures: [] }));
    }
    return playwrightReport(run, files);
  } finally {
    rmSync(io, { recursive: true, force: true });
  }
}

function playwrightReport(run, files) {
  const rootDir = run.config?.rootDir ?? '';
  const toFile = (abs) => files.find((f) => abs === f || abs.endsWith(`/${f}`)) ?? null;
  const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const tests = [];
  const visit = (suite, titles) => {
    const file = toFile(path.posix.join(rootDir, suite.file ?? ''));
    for (const spec of suite.specs ?? []) {
      if (file === null) continue;
      const name = controlFree([...titles, spec.title].join(' > '));
      for (const t of spec.tests ?? []) {
        const result = (t.results ?? []).at(-1);
        if (result === undefined || result.status === 'skipped') {
          tests.push({ file, name, outcome: 'skipped', failures: [] });
          continue;
        }
        if (result.status === 'passed') {
          tests.push({ file, name, outcome: 'passed', failures: [] });
          continue;
        }
        const errors = (result.errors ?? []).length > 0 ? result.errors : result.error ? [result.error] : [];
        const failures = errors.map((e) => ({
          line: e.location && toFile(e.location.file) === file ? e.location.line : null,
          message: plain(e.message ?? '').split('\n')[0],
        }));
        const assertion = failures.every((f) => f.line !== null && f.message.startsWith('Error: expect('));
        const outcome = result.status === 'failed' && failures.length > 0 && assertion ? 'failed-assertion' : 'errored';
        tests.push({ file, name, outcome, failures: failures.filter((f) => f.line !== null) });
      }
    }
    for (const child of suite.suites ?? []) visit({ ...child, file: child.file ?? suite.file }, [...titles, child.title]);
  };
  for (const suite of run.suites ?? []) visit(suite, []);
  if ((run.errors ?? []).length > 0) {
    for (const file of files) {
      if (!tests.some((t) => t.file === file)) tests.push({ file, name: 'the spec failed to load', outcome: 'errored', failures: [] });
    }
  }
  return tests;
}
