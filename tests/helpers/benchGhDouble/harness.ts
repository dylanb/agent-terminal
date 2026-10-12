// A per-test `gh` double: a `gh` on its own bin directory that points the double at this test's store, so
// the double can sit first on a run's allowlisted PATH while the run's environment carries nothing
// test-specific.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { shellQuote } from '../../../src/shared/shellQuote';
import {
  GH_DOUBLE_STORE_ENV,
  newRepo,
  readCalls,
  readState,
  withLock,
  writeScript,
  writeState,
  type GhCall,
  type GhIssue,
  type GhPull,
  type GhRepo,
  type GhScriptRule,
} from './store';

const GH_DOUBLE_EXECUTABLE = resolve(__dirname, 'gh');

export interface GhDouble {
  binDir: string;
  storeDir: string;
  calls(): GhCall[];
  repos(): Record<string, GhRepo>;
  issues(slug: string): GhIssue[];
  pulls(slug: string): GhPull[];
  script(rules: GhScriptRule[]): void;
  /** A repository made in the store directly — as if the developer had made it — carrying no benchmark marker. */
  createRepoDirect(slug: string): void;
}

export function createGhDouble(root: string): GhDouble {
  const dir = join(root, 'gh-double');
  const storeDir = join(dir, 'store');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), `#!/usr/bin/env bash\nexport ${GH_DOUBLE_STORE_ENV}=${shellQuote(storeDir)}\nexec ${shellQuote(GH_DOUBLE_EXECUTABLE)} "$@"\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  return {
    binDir,
    storeDir,
    calls: () => readCalls(storeDir),
    repos: () => readState(storeDir).repos,
    issues: (slug) => readState(storeDir).repos[slug]?.issues ?? [],
    pulls: (slug) => readState(storeDir).repos[slug]?.pulls ?? [],
    script: (rules) => writeScript(storeDir, rules),
    createRepoDirect: (slug) =>
      withLock(storeDir, () => {
        const state = readState(storeDir);
        const r = newRepo(storeDir, slug, { private: true, description: '' });
        mkdirSync(r.bare, { recursive: true });
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', r.bare]);
        state.repos[slug] = r;
        writeState(storeDir, state);
      }),
  };
}
