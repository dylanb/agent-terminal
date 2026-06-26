import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateShim } from '../../src/main/cliShim';

// Process-level behavior of the generated shim (§23.4 / #25): run the REAL generated script through
// /bin/sh and observe what it forwards across the OS boundary, with a recorder standing in for the app
// binary. The recorder writes its received APP_LAUNCH_DIR so the test reads the launch target the shim
// actually produced — forwarding correctness AND the trust boundary, not a string match on the source.

let work: string;
let recOut: string;
let shimPath: string;
let fixtureCwd: string;

/** A stand-in "app binary" that records the APP_LAUNCH_DIR it was launched with, then exits. */
function recorderShim(extra = ''): void {
  const recorder = join(work, 'recorder.sh');
  writeFileSync(recorder, `#!/bin/sh\n${extra}printf '%s' "$APP_LAUNCH_DIR" > "${recOut}"\n`);
  chmodSync(recorder, 0o755);
  shimPath = join(work, 'agent-terminal');
  writeFileSync(shimPath, generateShim({ execPath: recorder, appArgs: [] }));
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
  execFileSync(shimPath, args, { cwd: fixtureCwd, timeout: 5000 });
  return readWhenReady(recOut);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'agent-term-shim-'));
  recOut = join(work, 'launch-target.txt');
  fixtureCwd = mkdtempSync(join(tmpdir(), 'agent-term-shim-cwd-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixtureCwd, { recursive: true, force: true });
});

describe('shim forwarding (§23.4)', () => {
  it('forwards the invoking shell cwd as the target when given no argument', async () => {
    recorderShim();
    expect(resolve(await runShim([]))).toBe(resolve(fixtureCwd));
  });

  it('resolves a relative argument against the invoking shell cwd, not the launched process cwd', async () => {
    mkdirSync(join(fixtureCwd, 'sub'));
    recorderShim();
    expect(resolve(await runShim(['sub']))).toBe(join(fixtureCwd, 'sub'));
    expect(resolve(await runShim(['./sub']))).toBe(join(fixtureCwd, 'sub'));
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
    expect(resolve(await readWhenReady(recOut))).toBe(resolve(fixtureCwd));
  });
});

describe('shim injection safety (§23.4 trust boundary, CWE-78)', () => {
  it('forwards a path with shell metacharacters as one verbatim operand, executing nothing', async () => {
    recorderShim();
    const evil = 'a b; touch evil-marker';
    const got = await runShim([evil]);
    expect(got).toBe(join(fixtureCwd, evil));
    expect(existsSync(join(fixtureCwd, 'evil-marker'))).toBe(false);
    expect(existsSync(join(work, 'evil-marker'))).toBe(false);
  });

  it('forwards a command-substitution path literally without evaluating it', async () => {
    recorderShim();
    const evil = '$(touch pwned)';
    const got = await runShim([evil]);
    expect(got).toBe(join(fixtureCwd, evil));
    expect(existsSync(join(fixtureCwd, 'pwned'))).toBe(false);
  });

  it('treats a leading -- argument as a directory operand, not a launcher flag', async () => {
    recorderShim();
    expect(await runShim(['--foo'])).toBe(join(fixtureCwd, '--foo'));
  });
});
