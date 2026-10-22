// Per-test roots for the bench runner (#180): a home, an app-state home and a Claude config root, each its own
// temp dir, handed to the runner as a constructed env (never `process.env`, whose `INIT_CWD` under `pnpm test`
// names this checkout), and a copy of the shipped loops-v2 as the app bundle, so a revision test can edit a
// prompt without touching the checkout.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_HOME_DIR_ENV } from '../../src/main/launchRoot';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import type { BundleLocation } from '../../src/main/bundleLocation';

export interface BenchRoots {
  home: string;
  /** Holds no `.agent-terminal/`: the first-run app home. */
  appHome: string;
  configDir: string;
  bundle: BundleLocation;
  /** HOME, APP_HOME_DIR and CLAUDE_CONFIG_DIR set to the roots, PATH inherited, then `extra`. The same three
   *  are set on `process.env` until `cleanup()`, so a resolver that reads the process's own env meets the roots. */
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  cleanup(): void;
}

export function createBenchRoots(): BenchRoots {
  const tracked: string[] = [];
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    tracked.push(dir);
    return dir;
  };
  const home = temp('bench-home');
  const appHome = temp('bench-app-home');
  const configDir = temp('bench-claude-config');
  const bundle: BundleLocation = { packaged: false, appPath: temp('bench-bundle') };
  cpSync(resolveExampleLoopsV2Dir({ packaged: false, appPath: process.cwd() }), resolveExampleLoopsV2Dir(bundle), { recursive: true });
  const pointed: Record<string, string> = { HOME: home, [APP_HOME_DIR_ENV]: appHome, CLAUDE_CONFIG_DIR: configDir };
  const saved = Object.fromEntries(Object.keys(pointed).map((k) => [k, process.env[k]]));
  Object.assign(process.env, pointed);
  return {
    home,
    appHome,
    configDir,
    bundle,
    env: (extra = {}) => ({ PATH: process.env.PATH, ...pointed, ...extra }),
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      while (tracked.length) rmSync(tracked.pop()!, { recursive: true, force: true });
    },
  };
}
