import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShim } from '../../src/main/cliShim';
import { shellQuote } from '../../src/shared/shellQuote';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(['--validate-flow', '--check-repeat-list'])('AppImage %s uses the current mount after the installing mount disappears', (flag) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appimage-checker-')));
  roots.push(root);
  const appImage = join(root, 'my app.AppImage');
  const mounted = join(root, 'new mount');
  const main = join(mounted, 'resources', 'app.asar', 'out', 'main');
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'artifactCheck.js'), 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), node: process.env.ELECTRON_RUN_AS_NODE }));');
  writeFileSync(appImage, `#!/bin/sh\nexport APPDIR=${shellQuote(mounted)}\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
  const shim = join(root, 'agent-terminal');
  writeFileSync(shim, generateShim({ kind: 'appImage', appImage }, join(root, 'gone mount', 'artifactCheck.js')), { mode: 0o755 });
  const args = [flag, 'a folder; $(touch wrong)', 'list name'];
  const actual: unknown = JSON.parse(execFileSync(shim, args, { cwd: root, encoding: 'utf8' }));
  expect(actual).toEqual({ args, cwd: root, node: '1' });
});
