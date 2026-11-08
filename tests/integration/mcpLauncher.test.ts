import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { refreshMcpLauncher } from '../../src/main/mcpLauncher';
import { windowSessionEnv } from '../../src/main/mcpSessionEnv';

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

const run = (launch: { command: string; args: string[] }): string => execFileSync(launch.command, launch.args, { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();

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
    const ran = spawnSync(launch.command, launch.args, { encoding: 'utf8', cwd, env: { PATH: process.env.PATH } });
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

  it('does nothing, silently, once the build it points at is gone, so the servers and hooks it runs never fail', async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const exe = build('removed');
    const launch = await refreshMcpLauncher(appHome, { execPath: exe, appArgs: [] });
    rmSync(dirname(exe), { recursive: true, force: true });
    const ran = spawnSync(launch.command, launch.args, { encoding: 'utf8', input: '', env: { PATH: process.env.PATH } });
    expect({ exit: ran.status, stdout: ran.stdout, stderr: ran.stderr }).toEqual({ exit: 0, stdout: '', stderr: '' });
  });

  it("runs the build of the window a session is in, whichever build wrote the launcher last", async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const launch = await refreshMcpLauncher(appHome, { execPath: build('latest'), appArgs: ['latest.js'] });
    const ownBuild = build('window');
    const env = windowSessionEnv({ PATH: process.env.PATH }, '/app-home/mcp/w.sock', { execPath: ownBuild, script: 'window.js' });
    expect(execFileSync(launch.command, launch.args, { encoding: 'utf8', env }).trim()).toMatch(/^window window\.js/);
  });

  it("answers a hook outside any agent-terminal window at once, without starting the app", async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const launch = await refreshMcpLauncher(appHome, { execPath: build('app'), appArgs: [] });
    const outside = spawnSync(launch.command, [...launch.args, '--hook'], { encoding: 'utf8', input: '{"hook_event_name":"Stop"}', env: { PATH: process.env.PATH } });
    const inWindow = spawnSync(launch.command, [...launch.args, '--hook'], { encoding: 'utf8', input: '{}', env: windowSessionEnv({ PATH: process.env.PATH }, '/app-home/mcp/w.sock') });
    expect({ outside: { exit: outside.status, stdout: outside.stdout, stderr: outside.stderr }, inWindowRanTheApp: inWindow.stdout.startsWith('app') }).toEqual({
      outside: { exit: 0, stdout: '', stderr: '' },
      inWindowRanTheApp: true,
    });
  });
});

describe("a session whose window's build is gone", () => {
  it('runs the build that wrote the launcher, so its servers and hooks still answer', async () => {
    const appHome = temp('agent-term-mcp-launcher-home-');
    const launch = await refreshMcpLauncher(appHome, { execPath: build('latest'), appArgs: ['latest.js'] });
    const gone = build('window');
    rmSync(dirname(gone), { recursive: true, force: true });
    const env = windowSessionEnv({ PATH: process.env.PATH }, '/app-home/mcp/w.sock', { execPath: gone, script: 'window.js' });
    const ran = spawnSync(launch.command, launch.args, { encoding: 'utf8', input: '', env });
    expect({ exit: ran.status, stderr: ran.stderr, output: ran.stdout.trim() }).toEqual({ exit: 0, stderr: '', output: expect.stringMatching(/^latest latest\.js/) });
  });
});
