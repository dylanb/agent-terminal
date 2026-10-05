import { vi } from 'vitest';
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';

/** One scripted answer. `argvPrefix` is matched against git's argv from the subcommand on, after any leading
 *  global options (`-c k=v`, `-C dir`, `--no-replace-objects`, …), so production's hardening flags never
 *  defeat a match. The first matching entry answers; every other invocation runs the real git. */
export interface GitInterception {
  readonly argvPrefix: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export interface PathGitStub {
  readonly binDir: string;
  /** The real git the stub execs for every invocation it does not intercept. */
  readonly realGit: string;
  /** Removes the stub's bin dir. Pair it with `vi.unstubAllEnvs()` in the caller's `afterEach`. */
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
  throw new Error('pathGitStub: no executable git on PATH');
}

function interceptionArm(i: GitInterception): string {
  const tests = [`[ "\${#sub[@]}" -ge ${i.argvPrefix.length} ]`];
  i.argvPrefix.forEach((arg, n) => tests.push(`[ "\${sub[${n}]}" = ${shellQuote(arg)} ]`));
  const out = i.stdout === undefined ? '' : `printf '%s' ${shellQuote(i.stdout)}; `;
  const err = i.stderr === undefined ? '' : `printf '%s' ${shellQuote(i.stderr)} >&2; `;
  return `if ${tests.join(' && ')}; then ${out}${err}exit ${i.exitCode}; fi`;
}

/** Installs a `git` stub first on `process.env.PATH` (via `vi.stubEnv`), so any code that spawns `git` through
 *  PATH at call time reaches it. */
export function installPathGitStub(interceptions: readonly GitInterception[]): PathGitStub {
  for (const i of interceptions) {
    if (!Number.isInteger(i.exitCode) || i.exitCode < 0 || i.exitCode > 255) {
      throw new RangeError(`pathGitStub: exitCode must be an integer 0–255; got ${i.exitCode}`);
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
    ...interceptions.map(interceptionArm),
    `exec ${shellQuote(realGit)} "$@"`,
    '',
  ].join('\n');
  const stubPath = join(binDir, 'git');
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
  vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);
  return {
    binDir,
    realGit,
    dispose: () => rmSync(binDir, { recursive: true, force: true }),
  };
}
