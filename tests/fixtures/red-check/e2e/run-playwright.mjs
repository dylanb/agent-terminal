#!/usr/bin/env node
// The host stand-in for scripts/e2e-podman.sh's red-check path: the same E2E_IO_DIR contract (select.txt in,
// report.json out), run by real Playwright against this directory's config.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const io = path.resolve(process.env.E2E_IO_DIR);
const select = readFileSync(path.join(io, 'select.txt'), 'utf8').split('\n').filter((l) => l !== '');
const run = spawnSync(process.execPath, [cli, 'test', '--config', path.join(here, 'playwright.config.mjs'), '--reporter=list,json', ...select], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(io, 'report.json') },
});
process.exitCode = run.status ?? 1;
