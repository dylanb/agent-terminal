import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GitRepoFixture } from './gitRepo';
import { TEST_PROOF_GH_ORIGIN } from './testProofGh';

export const FIXTURES = resolve(__dirname, '../fixtures/test-proof');

export interface VitestScript {
  exitCode: number;
  report: string | null;
}

export interface E2eScript {
  exitCode: number;
  report: string | null;
  environment: string | null;
}

export interface SuiteRunRecord {
  suite: 'vitest' | 'e2e';
  argv: string[];
  cwd: string;
  env: { E2E_GREP: string | null; E2E_IO_DIR: string | null; E2E_REPORT_DIR: string | null };
}

export interface SuiteStandInState {
  vitest: VitestScript;
  e2e: E2eScript;
  runs: SuiteRunRecord[];
}

export interface SuiteStandIns {
  /** `root` with symlinks resolved, as a spawned process reports its cwd (macOS temp dirs sit under a symlink). */
  root: string;
  read(): SuiteStandInState;
  set(patch: Partial<Omit<SuiteStandInState, 'runs'>>): void;
}

const standIn = (suite: 'vitest' | 'e2e', stateFile: string) => String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const argv = process.argv.slice(2);
const env = (k) => (process.env[k] === undefined ? null : process.env[k]);
state.runs.push({ suite: ${JSON.stringify(suite)}, argv, cwd: fs.realpathSync(process.cwd()), env: { E2E_GREP: env('E2E_GREP'), E2E_IO_DIR: env('E2E_IO_DIR'), E2E_REPORT_DIR: env('E2E_REPORT_DIR') } });
fs.writeFileSync(stateFile, JSON.stringify(state));
const script = state[${JSON.stringify(suite)}];
const place = (from, to) => { if (from !== null && from !== undefined) fs.copyFileSync(from, to); };
if (${JSON.stringify(suite)} === 'vitest' && argv[0] !== 'test') {
  process.stderr.write('stand-in pnpm: unexpected ' + JSON.stringify(argv) + '\n');
  script.exitCode = 97;
} else if (${JSON.stringify(suite)} === 'vitest' && !argv.some((a, i) => a === '--reporter=json' || (a === '--reporter' && argv[i + 1] === 'json'))) {
  process.stderr.write('stand-in pnpm: no json reporter requested ' + JSON.stringify(argv) + '\n');
  script.exitCode = 97;
} else if (${JSON.stringify(suite)} === 'vitest') {
  const flag = argv.find((a) => a.startsWith('--outputFile.json=') || a.startsWith('--outputFile='));
  if (flag) place(script.report, path.resolve(flag.slice(flag.indexOf('=') + 1)));
} else {
  const root = path.resolve(__dirname, '..');
  const dir = process.env.E2E_REPORT_DIR;
  if (dir) {
    place(script.report, path.join(root, dir, 'report.json'));
    place(script.environment, path.join(root, dir, 'environment.json'));
  }
}
process.exitCode = script.exitCode;
`;

/**
 * Installs the two suite stand-ins: `bin/pnpm` (answers only `pnpm test …`) and `root/scripts/e2e-podman.sh`.
 * Each records its argv, cwd and the three `E2E_*` values it saw, copies the scripted fixture file (`null`: writes
 * nothing) and exits with the scripted code. They follow the report contract: vitest exits 97 unless the json
 * reporter is selected (`--reporter=json` / `--reporter json`), as real vitest then writes no report, and writes
 * where `--outputFile.json=` / `--outputFile=` points; the e2e stand-in writes `report.json` and `environment.json` into
 * the repo-relative `E2E_REPORT_DIR`, and nothing when it is unset. Neither creates a directory, so a missing
 * report dir fails the write and the stand-in exits non-zero. The state file lives in `stateDir`, outside `root`.
 */
export function installSuiteStandIns(opts: { root: string; bin: string; stateDir: string }): SuiteStandIns {
  for (const dir of [opts.bin, opts.stateDir, join(opts.root, 'scripts')]) mkdirSync(dir, { recursive: true });
  const stateFile = join(opts.stateDir, 'suite-stand-ins.json');
  const read = (): SuiteStandInState => JSON.parse(readFileSync(stateFile, 'utf8')) as SuiteStandInState;
  const write = (state: SuiteStandInState) => writeFileSync(stateFile, JSON.stringify(state));
  write({
    vitest: { exitCode: 0, report: join(FIXTURES, 'vitest-pass.json') },
    e2e: { exitCode: 0, report: join(FIXTURES, 'playwright-pass.json'), environment: join(FIXTURES, 'environment.json') },
    runs: [],
  });
  writeFileSync(join(opts.bin, 'pnpm'), standIn('vitest', stateFile), { mode: 0o755 });
  writeFileSync(join(opts.root, 'scripts', 'e2e-podman.sh'), standIn('e2e', stateFile), { mode: 0o755 });
  return { root: realpathSync(opts.root), read, set: (patch) => write({ ...read(), ...patch }) };
}

export function writeElectronPackage(root: string, version: string): void {
  const file = join(root, 'node_modules', 'electron', 'package.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ name: 'electron', version }));
}

export interface ProofRepo {
  dir: string;
  head: string;
  branch: string;
  suites: SuiteStandIns;
}

/**
 * A committed, clean repo on `branch` whose `origin` is the stand-in GitHub repository, with the e2e stand-in
 * committed at `scripts/e2e-podman.sh`, a `.gitignore` covering `node_modules/` and `.agent-terminal/`, and a
 * git-ignored Electron `electronVersion`. `bin` (the `pnpm` stand-in) and `stateDir` must lie outside the repo.
 */
export function makeProofRepo(
  git: GitRepoFixture,
  opts: { bin: string; stateDir: string; branch: string; electronVersion: string },
): ProofRepo {
  const dir = git.makeGitRepo('test-proof-repo');
  git.writeRepoFile(dir, '.gitignore', 'node_modules/\n.agent-terminal/\n');
  const suites = installSuiteStandIns({ root: dir, bin: opts.bin, stateDir: opts.stateDir });
  git.git(dir, ['checkout', '-q', '-b', opts.branch]);
  const head = git.commitAll(dir, 'proof fixture');
  git.git(dir, ['remote', 'add', 'origin', TEST_PROOF_GH_ORIGIN]);
  writeElectronPackage(dir, opts.electronVersion);
  return { dir: suites.root, head, branch: opts.branch, suites };
}
