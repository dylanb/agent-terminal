import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';

/** One scripted answer. `argvPrefix` is matched against git's argv from the subcommand on, after any leading
 *  global options (`-c k=v`, `-C dir`, `--no-replace-objects`, …), so production's hardening flags never
 *  defeat a match. The first matching entry answers; every other invocation runs the real git. A matching
 *  entry's `script` (bash source) runs first; with no `exitCode` the real git then answers. */
export type GitInterception =
  | { readonly argvPrefix: readonly string[]; readonly script?: string; readonly stdout?: string; readonly stderr?: string; readonly exitCode: number }
  | { readonly argvPrefix: readonly string[]; readonly script: string };

export interface GitStubBin {
  /** The directory holding the `git` stub; put it first on the PATH of the process that should reach it. */
  readonly binDir: string;
  /** The real git the stub execs for every invocation it does not intercept. */
  readonly realGit: string;
  dispose(): void;
}

const GLOBAL_OPTIONS_WITH_VALUE = ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'];

function resolveRealGit(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('gitStubBin: no executable git on PATH');
}

function interceptionArm(i: GitInterception, realGit: string): string {
  const tests = [`[ "\${#sub[@]}" -ge ${i.argvPrefix.length} ]`];
  i.argvPrefix.forEach((arg, n) => tests.push(`[ "\${sub[${n}]}" = ${shellQuote(arg)} ]`));
  const script = i.script === undefined ? '' : `eval ${shellQuote(i.script)}; `;
  if (!('exitCode' in i)) return `if ${tests.join(' && ')}; then ${script}exec ${shellQuote(realGit)} "$@"; fi`;
  const out = i.stdout === undefined ? '' : `printf '%s' ${shellQuote(i.stdout)}; `;
  const err = i.stderr === undefined ? '' : `printf '%s' ${shellQuote(i.stderr)} >&2; `;
  return `if ${tests.join(' && ')}; then ${script}${out}${err}exit ${i.exitCode}; fi`;
}

/** Writes a `git` stub into a fresh temp dir. It touches no environment: vitest callers use
 *  `installPathGitStub`, and an e2e passes `binDir` on the launched app's PATH. */
export function writeGitStubBin(interceptions: readonly GitInterception[]): GitStubBin {
  for (const i of interceptions) {
    if (!('exitCode' in i) && typeof i.script === 'string') continue;
    const exitCode = (i as { exitCode?: unknown }).exitCode;
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new RangeError(`gitStubBin: exitCode must be an integer 0–255; got ${String(exitCode)}`);
    }
  }
  const realGit = resolveRealGit();
  const binDir = mkdtempSync(join(tmpdir(), 'path-git-stub-'));
  const script = [
    '#!/usr/bin/env bash',
    'args=("$@")',
    'i=0',
    'while [ "$i" -lt "${#args[@]}" ]; do',
    '  case "${args[$i]}" in',
    `    ${GLOBAL_OPTIONS_WITH_VALUE.join('|')}) i=$((i + 2)) ;;`,
    '    -*) i=$((i + 1)) ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'sub=("${args[@]:$i}")',
    ...interceptions.map((i) => interceptionArm(i, realGit)),
    `exec ${shellQuote(realGit)} "$@"`,
    '',
  ].join('\n');
  const stubPath = join(binDir, 'git');
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
  return { binDir, realGit, dispose: () => rmSync(binDir, { recursive: true, force: true }) };
}
