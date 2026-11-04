import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateShim, type LaunchInvocation } from '../../src/main/cliShim';

// Process-level behavior of the generated shim (§23.4 / #25): run the REAL generated script through
// /bin/sh and observe what it forwards across the OS boundary, with a recorder standing in for the app
// binary. The recorder writes its received APP_LAUNCH_DIR so the test reads the launch target the shim
// actually produced — forwarding correctness AND the trust boundary, not a string match on the source.

let work: string;
let recOut: string;
let shimPath: string;
let fixtureCwd: string;
let realCwd: string;

/** A stand-in "app binary" that records the APP_LAUNCH_DIR it was launched with, then exits. */
function recorderShim(extra = ''): void {
  const recorder = join(work, 'recorder.sh');
  writeFileSync(recorder, `#!/bin/sh\n${extra}printf '%s' "$APP_LAUNCH_DIR" > "${recOut}.tmp" && mv "${recOut}.tmp" "${recOut}"\n`);
  chmodSync(recorder, 0o755);
  shimPath = join(work, 'agent-terminal');
  writeFileSync(shimPath, generateShim({ kind: 'packaged', execPath: recorder }));
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
    writeFileSync(shimPath, generateShim(invocation));
    chmodSync(shimPath, 0o755);
  }

  const macBinary = (dir: string, name: string): string => join(dir, `${name}.app`, 'Contents', 'MacOS', name);

  it('launches the macOS controller from the build output beside the terminal build', async () => {
    const terminal = macBinary(join(work, 'dist', 'mac-arm64'), 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(macBinary(join(work, 'dist', 'controller', 'mac-arm64'), 'agent-terminal-controller'), 'controller');
    shimFor({ kind: 'packaged', execPath: terminal });
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches a macOS controller app installed next to the terminal app', async () => {
    const terminal = macBinary(join(work, 'Applications'), 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(macBinary(join(work, 'Applications'), 'agent-terminal-controller'), 'controller');
    shimFor({ kind: 'packaged', execPath: terminal });
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches the Linux controller from the build output beside the terminal build', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(join(work, 'dist', 'controller', 'linux-arm64-unpacked', 'agent-terminal-controller'), 'controller');
    shimFor({ kind: 'packaged', execPath: terminal });
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches a Linux controller installed next to the terminal install', async () => {
    const terminal = join(work, 'opt', 'agent-terminal', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    recorderAt(join(work, 'opt', 'agent-terminal-controller', 'agent-terminal-controller'), 'controller');
    shimFor({ kind: 'packaged', execPath: terminal });
    expect(await runShim(['--controller'])).toBe('controller:');
  });

  it('launches the dev controller entry with the same Electron as the dev terminal', async () => {
    const electron = join(work, 'electron');
    recorderAt(electron, 'electron');
    const mainDir = join(work, 'out', 'main');
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(join(mainDir, 'index.js'), '');
    writeFileSync(join(mainDir, 'controller.js'), '');
    shimFor({ kind: 'development', execPath: electron, startPath: join(mainDir, 'index.js'), mainDir });
    expect(await runShim(['--controller'])).toBe(`electron:${join(mainDir, 'controller.js')}`);
  });

  it('launches the dev controller when electron-vite dev started Electron on the app root', async () => {
    const electron = join(work, 'electron');
    recorderAt(electron, 'electron');
    const appRoot = join(work, 'clone');
    const mainDir = join(appRoot, 'out', 'main');
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(join(mainDir, 'controller.js'), '');
    shimFor({ kind: 'development', execPath: electron, startPath: appRoot, mainDir });
    expect(await runShim(['--controller'])).toBe(`electron:${join(mainDir, 'controller.js')}`);
  });

  it('launches a dev terminal by starting the same Electron on the path it was started on', async () => {
    const electron = join(work, 'electron');
    recorderAt(electron, 'electron');
    const appRoot = join(work, 'clone');
    shimFor({ kind: 'development', execPath: electron, startPath: appRoot, mainDir: join(appRoot, 'out', 'main') });
    expect(await runShim([])).toBe(`electron:${appRoot}`);
  });

  it('finds a controller that appeared after the launcher was installed', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    shimFor({ kind: 'packaged', execPath: terminal });
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
    shimFor({ kind: 'packaged', execPath: terminal });
    execFileSync(shimPath, ['--controller'], { cwd: fixtureCwd, timeout: 5000 });
    expect(existsSync(recOut)).toBe(false);
    writeFileSync(go, '');
    expect(await readWhenReady(recOut)).toBe('controller:');
  });

  it('fails visibly, launching nothing, when no controller is found', async () => {
    const terminal = join(work, 'dist', 'linux-arm64-unpacked', 'agent-terminal');
    recorderAt(terminal, 'terminal');
    shimFor({ kind: 'packaged', execPath: terminal });
    const run = spawnSync(shimPath, ['--controller'], { cwd: fixtureCwd, timeout: 5000, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/controller/i);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(recOut)).toBe(false);
  });

  it('still treats a directory named --controller as a target when spelled as a path', async () => {
    mkdirSync(join(fixtureCwd, '--controller'));
    recorderShim();
    expect(resolve(await runShim(['./--controller']))).toBe(join(realCwd, '--controller'));
  });
});
