// §28.5.2 — this repo's red_check_command (loop-capabilities.yaml); its stdout must parse as the report in
// src/shared/redCheck.ts.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const dir = mkdtempSync(path.join(tmpdir(), 'red-check-'));
const out = path.join(dir, 'vitest.json');

try {
  spawnSync(process.execPath, [vitestBin, 'run', '--reporter=json', `--outputFile=${out}`, ...process.argv.slice(2)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let run;
  try {
    run = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    process.stderr.write('red-check: vitest produced no JSON report\n');
    process.exitCode = 1;
  }
  if (run !== undefined) report(run);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function report(run) {
  const rel = (abs) => path.relative(process.cwd(), abs).split(path.sep).join('/');
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
      const name = [...t.ancestorTitles, t.title].join(' > ').replace(/[\u0000-\u001f\u007f]/g, ' ');
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
  process.stdout.write(`${JSON.stringify({ version: 1, tests }, null, 2)}\n`);
}
