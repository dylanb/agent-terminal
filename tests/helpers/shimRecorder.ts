// A stand-in app binary for a launcher branch that runs in the foreground: it records what it was started with
// (each argv element verbatim, its real working directory, whether plain-Node mode was asked for), prints the
// test's chosen text to both streams and exits with the test's chosen status, so the test can see that the
// launcher passed all three back.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';

export interface ForegroundRecording {
  argv: string[];
  cwd: string;
  /** `ELECTRON_RUN_AS_NODE` as the binary saw it; null when unset. */
  runAsNode: string | null;
}

export interface ForegroundRecorder {
  /** The executable to hand the launcher as its app binary. */
  binary: string;
  read(): ForegroundRecording;
}

export function writeForegroundRecorder(
  dir: string,
  output: { stdout: string; stderr: string; exitCode: number },
): ForegroundRecorder {
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, 'recorder');
  const argvFile = join(dir, 'recorded-argv');
  const cwdFile = join(dir, 'recorded-cwd');
  const envFile = join(dir, 'recorded-run-as-node');
  writeFileSync(binary, [
    '#!/bin/sh',
    `: > ${shellQuote(argvFile)}`,
    `for a in "$@"; do printf '%s\\0' "$a" >> ${shellQuote(argvFile)}; done`,
    `pwd -P > ${shellQuote(cwdFile)}`,
    `if [ "\${ELECTRON_RUN_AS_NODE+set}" = set ]; then printf 'set:%s' "$ELECTRON_RUN_AS_NODE"; else printf unset; fi > ${shellQuote(envFile)}`,
    `printf '%s' ${shellQuote(output.stdout)}`,
    `printf '%s' ${shellQuote(output.stderr)} >&2`,
    `exit ${output.exitCode}`,
    '',
  ].join('\n'));
  chmodSync(binary, 0o755);
  return {
    binary,
    read() {
      const env = readFileSync(envFile, 'utf8');
      return {
        argv: readFileSync(argvFile, 'utf8').split('\0').slice(0, -1),
        cwd: readFileSync(cwdFile, 'utf8').replace(/\n$/, ''),
        runAsNode: env.startsWith('set:') ? env.slice('set:'.length) : null,
      };
    },
  };
}
