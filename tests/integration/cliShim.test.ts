import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateShim, resolveLaunchInvocation, type LaunchInvocation } from '../../src/main/cliShim';
import { writeForegroundRecorder } from '../helpers/shimRecorder';

// Process-level behavior of the generated shim (§23.4 / #25): run the REAL generated script through
// /bin/sh and observe what it forwards across the OS boundary, with a recorder standing in for the app
// binary. The recorder writes its received APP_LAUNCH_DIR so the test reads the launch target the shim
// actually produced — forwarding correctness AND the trust boundary, not a string match on the source.

let work: string;
let recOut: string;
let shimPath: string;
let fixtureCwd: string;
let realCwd: string;

/** The checker runtime script each generated shim is given; its directory has a space, so a shim that splices it
 *  into shell text unquoted runs the wrong file. */
const CHECKER_SCRIPT = '/opt/agent terminal/out/main/artifactCheck.js';

/** A stand-in "app binary" that records the APP_LAUNCH_DIR it was launched with, then exits. */
function recorderShim(extra = ''): void {
  const recorder = join(work, 'recorder.sh');
  writeFileSync(recorder, `#!/bin/sh\n${extra}printf '%s' "$APP_LAUNCH_DIR" > "${recOut}.tmp" && mv "${recOut}.tmp" "${recOut}"\n`);
  chmodSync(recorder, 0o755);
  shimPath = join(work, 'agent-terminal');
  writeFileSync(shimPath, generateShim(resolveLaunchInvocation(recorder, false, undefined, work), CHECKER_SCRIPT));
  chmodSync(shimPath, 0o755);
}

async function readWhenReady(file: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/** Run the shim from the fixture cwd with the given args and return the recorded launch target. */
async function runShim(args: string[]): Promise<string> {
  rmSync(recOut, { force: true });
  execFileSync(shimPath, args, { cwd: fixtureCwd, timeout: 5000 });
  return readWhenReady(recOut);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'agent-term-shim-'));
  recOut = join(work, 'launch-target.txt');
  fixtureCwd = mkdtempSync(join(tmpdir(), 'agent-term-shim-cwd-'));
  realCwd = realpathSync(fixtureCwd);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixtureCwd, { recursive: true, force: true });
});

describe('shim forwarding (§23.4)', () => {
  it('forwards the invoking shell cwd as the target when given no argument', async () => {
    recorderShim();
    expect(await runShim([])).toBe(realCwd);
  });

  it('resolves a relative argument against the invoking shell cwd, not the launched process cwd', async () => {
    mkdirSync(join(fixtureCwd, 'sub'));
    recorderShim();
    expect(await runShim(['sub'])).toBe(join(realCwd, 'sub'));
    expect(resolve(await runShim(['./sub']))).toBe(join(realCwd, 'sub'));
  });

  it('reports each run its own launch target, so a later run never reads an earlier run\'s', async () => {
    mkdirSync(join(fixtureCwd, 'a'));
    mkdirSync(join(fixtureCwd, 'b'));
    recorderShim('sleep 0.2\n');
    expect(await runShim(['a'])).toBe(join(realCwd, 'a'));
    expect(await runShim(['b'])).toBe(join(realCwd, 'b'));
  });

  it('passes an absolute argument through unchanged', async () => {
    const abs = mkdtempSync(join(tmpdir(), 'agent-term-shim-abs-'));
    recorderShim();
    expect(resolve(await runShim([abs]))).toBe(resolve(abs));
    rmSync(abs, { recursive: true, force: true });
  });

  it('forwards an unusable (non-existent) target unchanged for the resolver to fall back on', async () => {
    const bogus = join(fixtureCwd, 'does-not-exist');
    recorderShim();
    expect(await runShim([bogus])).toBe(bogus);
  });

  it('returns immediately without waiting for the launched instance to exit', async () => {
    const go = join(work, 'go');
    recorderShim(`while [ ! -f "${go}" ]; do sleep 0.05; done\n`);
    execFileSync(shimPath, [], { cwd: fixtureCwd, timeout: 5000 });
    expect(existsSync(recOut)).toBe(false);
    writeFileSync(go, '');
    expect(await readWhenReady(recOut)).toBe(realCwd);
  });
});

describe('shim injection safety (§23.4 trust boundary, CWE-78)', () => {
  it('forwards a path with shell metacharacters as one verbatim operand, executing nothing', async () => {
    recorderShim();
    const evil = 'a b; touch evil-marker';
    const got = await runShim([evil]);
    expect(got).toBe(join(realCwd, evil));
    expect(existsSync(join(fixtureCwd, 'evil-marker'))).toBe(false);
    expect(existsSync(join(work, 'evil-marker'))).toBe(false);
  });

  it('forwards a command-substitution path literally without evaluating it', async () => {
    recorderShim();
    const evil = '$(touch pwned)';
    const got = await runShim([evil]);
    expect(got).toBe(join(realCwd, evil));
    expect(existsSync(join(fixtureCwd, 'pwned'))).toBe(false);
  });

  it('treats a leading -- argument as a directory operand, not a launcher flag', async () => {
    recorderShim();
    expect(await runShim(['--foo'])).toBe(join(realCwd, '--foo'));
  });
});

describe('shim --controller (§23.5)', () => {
  /** A stand-in binary at `file` that records `<label>:<args>` to recOut, then exits. */
  function recorderAt(file: string, label: string, extra = ''): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${extra}printf '%s' "${label}:$*" > "${recOut}.tmp" && mv "${recOut}.tmp" "${recOut}"\n`);
    chmodSync(file, 0o755);
  }

  function shimFor(invocation: LaunchInvocation): void {
    shimPath = join(work, 'agent-terminal');
    writeFileSync(shimPath, generateShim(invocation, CHECKER_SCRIPT));
    chmodSync(shimPath, 0o755);
  }

  const macBinary = (dir: string, name: string): string => join(dir, `${name}.app`, 'Contents', 'MacOS', name);

  it('launches the macOS controller from the build output beside the terminal build', async () => {
    const terminal = macBinary(join(work, 'dist', 'mac-arm64'), 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(macBinary(join(work, 'dist', 'controller', 'mac-arm64'), 'agent-terminal-controller'), 'controller');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches a macOS controller app installed next to the terminal app', async () => {
    const terminal = macBinary(join(work, 'Applications'), 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(macBinary(join(work, 'Applications'), 'agent-terminal-controller'), 'controller');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches the Linux controller from the build output beside the terminal build', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(join(work, 'dist', 'controller', 'linux-arm64-unpacked', 'agent-terminal-controller'), 'controller');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches a Linux controller installed next to the terminal install', async () => {
    const terminal = join(work, 'opt', 'agent-terminal', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(join(work, 'opt', 'agent-terminal-controller', 'agent-terminal-controller'), 'controller');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches the dev controller entry with the same Electron as the dev terminal', async () => {
    const electron = join(work, 'electron');
    recorderAt(electron, 'electron');
    const mainDir = join(work, 'out', 'main');
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(join(mainDir, 'index.js'), '');
    writeFileSync(join(mainDir, 'controller.js'), '');
    shimFor(resolveLaunchInvocation(electron, true, join(mainDir, 'index.js'), work));
    expect(await runShim(['--controller'])).toBe(`electron:${join(mainDir, 'controller.js')}`);
  });

  it('finds a controller that appeared after the launcher was installed', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    recorderAt(join(work, 'dist', 'controller', 'linux-arm64-unpacked', 'agent-terminal-controller'), 'controller');
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('returns immediately without waiting for the controller to exit', async () => {
    const go = join(work, 'go');
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(
      join(work, 'dist', 'controller', 'linux-arm64-unpacked', 'agent-terminal-controller'),
      'controller',
      `while [ ! -f "${go}" ]; do sleep 0.05; done\n`,
    );
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    execFileSync(shimPath, ['--controller'], { cwd: fixtureCwd, timeout: 5000 });
    expect(existsSync(recOut)).toBe(false);
    writeFileSync(go, '');
    expect(await readWhenReady(recOut)).toBe('controller:');
  });

  it('fails visibly, launching nothing, when no controller is found', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    const run = spawnSync(shimPath, ['--controller'], { cwd: fixtureCwd, timeout: 5000, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/controller/i);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(recOut)).toBe(false);
  });

  it('names every place it looked when no controller is found', () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    shimFor(resolveLaunchInvocation(terminal, false, undefined, work));
    const run = spawnSync(shimPath, ['--controller'], { cwd: fixtureCwd, timeout: 5000, encoding: 'utf8' });
    expect(run.stderr).toContain(join(work, 'dist', 'agent-terminal-controller', 'agent-terminal-controller'));
    expect(run.stderr).toContain(join(work, 'dist', 'controller', 'linux-arm64-unpacked', 'agent-terminal-controller'));
  });

  it('still treats a directory named --controller as a target when spelled as a path', async () => {
    mkdirSync(join(fixtureCwd, '--controller'));
    recorderShim();
    expect(resolve(await runShim(['./--controller']))).toBe(join(realCwd, '--controller'));
  });
});

describe('shim for an AppImage launch (#306)', () => {
  /** A stand-in binary at `file` that records `<label>|<APP_LAUNCH_DIR>` to recOut, then exits. */
  function standIn(file: string, label: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\nprintf '%s' "${label}|$APP_LAUNCH_DIR" > "${recOut}.tmp" && mv "${recOut}.tmp" "${recOut}"\n`);
    chmodSync(file, 0o755);
  }

  /** An AppImage stand-in at `appImagePath` plus a differently-labelled "running binary" inside a mount
   *  dir; the invocation comes from the production resolver, as the running app would obtain it. */
  function appImageInvocation(appImagePath: string): { invocation: LaunchInvocation; mountDir: string } {
    const mountDir = join(work, 'mnt', '.mount_agentX');
    const mountBinary = join(mountDir, 'usr', 'bin', 'agent-terminal');
    standIn(appImagePath, 'appimage');
    standIn(mountBinary, 'mount');
    const invocation = resolveLaunchInvocation(mountBinary, false, undefined, work, { appImage: appImagePath, mountDir });
    return { invocation, mountDir };
  }

  function writeShim(invocation: LaunchInvocation): void {
    shimPath = join(work, 'agent-terminal');
    writeFileSync(shimPath, generateShim(invocation, CHECKER_SCRIPT));
    chmodSync(shimPath, 0o755);
  }

  async function launchedWithin(args: string[], timeoutMs = 3000): Promise<string | null> {
    rmSync(recOut, { force: true });
    execFileSync(shimPath, args, { cwd: fixtureCwd, timeout: 5000 });
    try {
      return await readWhenReady(recOut, timeoutMs);
    } catch {
      return null;
    }
  }

  async function runFailing(args: string[]): Promise<{ status: number | null; stderr: string; launched: boolean }> {
    rmSync(recOut, { force: true });
    const run = spawnSync(shimPath, args, { cwd: fixtureCwd, timeout: 5000, encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 200));
    return { status: run.status, stderr: run.stderr, launched: existsSync(recOut) };
  }

  it('launches the AppImage file, not the mount binary, with the directory argument as the launch target', async () => {
    const appImage = join(work, 'apps', 'agent-terminal-1.4.0.AppImage');
    writeShim(appImageInvocation(appImage).invocation);
    mkdirSync(join(fixtureCwd, 'proj'));
    expect(await launchedWithin(['proj'])).toBe(`appimage|${join(realCwd, 'proj')}`);
  });

  it('keeps launching the AppImage after the mount it was installed from is gone', async () => {
    const appImage = join(work, 'apps', 'agent-terminal-1.4.0.AppImage');
    const { invocation, mountDir } = appImageInvocation(appImage);
    writeShim(invocation);
    rmSync(mountDir, { recursive: true, force: true });
    expect(await launchedWithin([])).toBe(`appimage|${realCwd}`);
  });

  it('launches the file now at the AppImage path after it is replaced in place', async () => {
    const appImage = join(work, 'apps', 'agent-terminal-1.4.0.AppImage');
    writeShim(appImageInvocation(appImage).invocation);
    standIn(appImage, 'appimage-replaced');
    expect(await launchedWithin([])).toBe(`appimage-replaced|${realCwd}`);
  });

  it.each([
    ['a release-style name', 'agent-terminal-1.4.0.AppImage', 'agent-terminal-controller-1.4.0.AppImage'],
    ['a fixed name', 'agent-terminal.AppImage', 'agent-terminal-controller.AppImage'],
  ])('--controller launches the sibling controller AppImage for %s', async (_what, terminalName, controllerName) => {
    const apps = join(work, 'apps');
    writeShim(appImageInvocation(join(apps, terminalName)).invocation);
    standIn(join(apps, controllerName), 'controller');
    standIn(join(apps, 'agent-terminal-controller-9.9.9.AppImage'), 'wrong-controller');
    const run = await runFailing(['--controller']);
    expect.soft(run.status).toBe(0);
    expect(await readWhenReady(recOut, 3000).catch(() => '')).toMatch(/^controller\|/);
  });

  it('--controller finds no candidate for an AppImage not named agent-terminal*, fails naming its folder, and launches nothing', async () => {
    const apps = join(work, 'apps');
    writeShim(appImageInvocation(join(apps, 'other.AppImage')).invocation);
    standIn(join(apps, 'agent-terminal-controller.AppImage'), 'controller');
    const run = await runFailing(['--controller']);
    expect.soft(run.status).not.toBe(0);
    expect.soft(run.stderr).toMatch(/no controller app found/i);
    expect.soft(run.stderr).toContain(apps);
    expect.soft(run.launched).toBe(false);
  });

  it('--controller names the sibling it looked for when that controller AppImage is missing', async () => {
    const apps = join(work, 'apps');
    writeShim(appImageInvocation(join(apps, 'agent-terminal-1.4.0.AppImage')).invocation);
    const run = await runFailing(['--controller']);
    expect.soft(run.status).not.toBe(0);
    expect.soft(run.stderr).toContain(join(apps, 'agent-terminal-controller-1.4.0.AppImage'));
    expect.soft(run.launched).toBe(false);
  });

  it.each([
    ['a plain launch', [] as string[]],
    ['--controller', ['--controller']],
  ])('fails naming the AppImage path, launching nothing, when the file is gone (%s)', async (_what, args) => {
    const apps = join(work, 'apps');
    const appImage = join(apps, 'agent-terminal-1.4.0.AppImage');
    writeShim(appImageInvocation(appImage).invocation);
    standIn(join(apps, 'agent-terminal-controller-1.4.0.AppImage'), 'controller');
    rmSync(appImage);
    const run = await runFailing(args);
    expect.soft(run.status).not.toBe(0);
    expect.soft(run.stderr).toContain(appImage);
    expect.soft(run.launched).toBe(false);
  });

  it('a plain launch fails naming the AppImage path, launching nothing, when the file is not executable', async () => {
    const apps = join(work, 'apps');
    const appImage = join(apps, 'agent-terminal-1.4.0.AppImage');
    writeShim(appImageInvocation(appImage).invocation);
    mkdirSync(join(fixtureCwd, 'proj'));
    chmodSync(appImage, 0o644);
    const run = await runFailing(['proj']);
    expect.soft(run.status).not.toBe(0);
    expect.soft(run.stderr).toContain(appImage);
    expect.soft(run.launched).toBe(false);
  });

  it('--controller still launches an executable controller sibling when the terminal AppImage is not executable', async () => {
    const apps = join(work, 'apps');
    const appImage = join(apps, 'agent-terminal-1.4.0.AppImage');
    writeShim(appImageInvocation(appImage).invocation);
    standIn(join(apps, 'agent-terminal-controller-1.4.0.AppImage'), 'controller');
    chmodSync(appImage, 0o644);
    const run = await runFailing(['--controller']);
    expect.soft(run.status).toBe(0);
    expect(await readWhenReady(recOut, 3000).catch(() => '')).toMatch(/^controller\|/);
  });

  it('decides from the paths it is given, leaving symlink resolution to whoever supplies the AppImage facts', () => {
    const appImage = join(work, 'apps', 'agent-terminal.AppImage');
    const binary = join(work, 'realtmp', '.mount_agentX', 'usr', 'bin', 'agent-terminal');
    standIn(appImage, 'appimage');
    standIn(binary, 'mount');
    symlinkSync(join(work, 'realtmp'), join(work, 'linktmp'));
    const invocation = resolveLaunchInvocation(realpathSync(binary), false, undefined, work, {
      appImage,
      mountDir: join(work, 'linktmp', '.mount_agentX'),
    });
    expect(invocation).toEqual({ kind: 'binary', execPath: realpathSync(binary), appArgs: [] });
  });
});

describe('shim --validate-flow (§23.5)', () => {
  const builds: [string, (binary: string) => LaunchInvocation][] = [
    ['packaged', (binary) => ({ kind: 'binary', execPath: binary, appArgs: [] })],
    ['dev', (binary) => ({ kind: 'binary', execPath: binary, appArgs: [join(work, 'out', 'main', 'index.js')] })],
  ];

  it.each(builds)('%s build: runs the checker runtime in the foreground, in plain-Node mode, with every operand verbatim', (_, invocationOf) => {
    const recorder = writeForegroundRecorder(join(work, 'binary'), { stdout: 'checked\n', stderr: 'a diagnostic\n', exitCode: 3 });
    shimPath = join(work, 'agent-terminal');
    writeFileSync(shimPath, generateShim(invocationOf(recorder.binary), CHECKER_SCRIPT));
    chmodSync(shimPath, 0o755);
    const operands = ['my flows; touch evil-marker', '$(touch pwned)', `it's "quoted" \`touch ticked\``];

    const run = spawnSync(shimPath, ['--validate-flow', ...operands], { cwd: fixtureCwd, encoding: 'utf8' });

    expect.soft({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 3, stdout: 'checked\n', stderr: 'a diagnostic\n' });
    expect.soft(recorder.read()).toEqual({ argv: [CHECKER_SCRIPT, '--validate-flow', ...operands], cwd: realCwd, runAsNode: '1' });
    expect.soft(['evil-marker', 'pwned', 'ticked'].filter((f) => existsSync(join(fixtureCwd, f)) || existsSync(join(work, f)))).toEqual([]);
  });

  it('still launches a directory named --validate-flow when it is spelled as a path or follows another operand', async () => {
    mkdirSync(join(fixtureCwd, '--validate-flow'));
    recorderShim();
    expect(resolve(await runShim(['./--validate-flow']))).toBe(join(realCwd, '--validate-flow'));
    expect(await runShim(['sub', '--validate-flow'])).toBe(join(realCwd, 'sub'));
  });
});

describe('shim --check-repeat-list (§23.5)', () => {
  const builds: [string, (binary: string) => LaunchInvocation][] = [
    ['packaged', (binary) => ({ kind: 'binary', execPath: binary, appArgs: [] })],
    ['dev', (binary) => ({ kind: 'binary', execPath: binary, appArgs: [join(work, 'out', 'main', 'index.js')] })],
  ];

  it.each(builds)('%s build: runs the checker runtime in the foreground, in plain-Node mode, with every operand verbatim', (_, invocationOf) => {
    const recorder = writeForegroundRecorder(join(work, 'binary'), { stdout: 'checked\n', stderr: 'a diagnostic\n', exitCode: 3 });
    shimPath = join(work, 'agent-terminal');
    writeFileSync(shimPath, generateShim(invocationOf(recorder.binary), CHECKER_SCRIPT));
    chmodSync(shimPath, 0o755);
    const operands = ['my list; touch evil-marker.json', 'the "steps" $(touch pwned)', `it's \`touch ticked\``];

    const run = spawnSync(shimPath, ['--check-repeat-list', ...operands], { cwd: fixtureCwd, encoding: 'utf8' });

    expect.soft({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 3, stdout: 'checked\n', stderr: 'a diagnostic\n' });
    expect.soft(recorder.read()).toEqual({ argv: [CHECKER_SCRIPT, '--check-repeat-list', ...operands], cwd: realCwd, runAsNode: '1' });
    expect.soft(['evil-marker.json', 'pwned', 'ticked'].filter((f) => existsSync(join(fixtureCwd, f)) || existsSync(join(work, f)))).toEqual([]);
  });

  it('still launches a directory named --check-repeat-list when it is spelled as a path or follows another operand', async () => {
    mkdirSync(join(fixtureCwd, '--check-repeat-list'));
    recorderShim();
    expect(resolve(await runShim(['./--check-repeat-list']))).toBe(join(realCwd, '--check-repeat-list'));
    expect(await runShim(['sub', '--check-repeat-list'])).toBe(join(realCwd, 'sub'));
  });
});
