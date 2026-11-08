import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { refreshMcpLauncher } from '../../src/main/mcpLauncher';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A stand-in app build at its own location: it prints its name and the arguments it was started with. */
function build(name: string): string {
  const exe = join(temp(`agent-term-build-${name}-`), 'agent-terminal');
  writeFileSync(exe, `#!/bin/sh\necho "${name} $*"\n`, { mode: 0o755 });
  return exe;
}

const run = (launch: { command: string; args: string[] }): string => execFileSync(launch.command, launch.args, { encoding: 'utf8' }).trim();

describe("the launch the Claude Code integration registers", () => {
  it('stays the same after the app is updated or moved, and starts the build that refreshed it last', async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const first = await refreshMcpLauncher(appHome, { execPath: build('old'), appArgs: ['app.asar'] });
    const firstRun = run(first);
    const second = await refreshMcpLauncher(appHome, { execPath: build('new'), appArgs: ['moved/app.asar'] });
    expect({ firstRun, sameLaunch: second, secondRun: run(first) }).toEqual({
      firstRun: expect.stringMatching(/^old app\.asar/),
      sameLaunch: first,
      secondRun: expect.stringMatching(/^new moved\/app\.asar/),
    });
  });

  it('starts a build whose path and arguments hold spaces, quotes and $(…) exactly, running nothing else', async () => {
    const appHome = temp("agent-term mcp 'home' $(touch pwned)-");
    const cwd = temp('agent-term-mcp-launcher-cwd-');
    const exe = join(temp("agent-term build 'x' $(touch pwned)-"), 'agent-terminal');
    writeFileSync(exe, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 });
    const launch = await refreshMcpLauncher(appHome, { execPath: exe, appArgs: ["it's $(touch pwned) app"] });
    const ran = spawnSync(launch.command, launch.args, { encoding: 'utf8', cwd });
    expect({ inAppHome: !relative(appHome, launch.command).startsWith('..'), exit: ran.status, stderr: ran.stderr, output: ran.stdout.trim(), ranSomethingElse: existsSync(join(cwd, 'pwned')) }).toEqual({
      inAppHome: true,
      exit: 0,
      stderr: '',
      output: expect.stringMatching(/^\[it's \$\(touch pwned\) app\]/),
      ranSomethingElse: false,
    });
  });

  it("lives in the app's own home, never inside the app bundle", async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const launch = await refreshMcpLauncher(appHome, { execPath: build('only'), appArgs: [] });
    expect(relative(appHome, launch.command).startsWith('..')).toBe(false);
  });
});
