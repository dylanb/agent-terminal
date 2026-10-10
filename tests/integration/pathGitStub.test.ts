import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPathGitStub, type GitInterception, type PathGitStub } from '../helpers/pathGitStub';

const viaPath = (args: string[], cwd?: string): { stdout: string; stderr: string; status: number | null } => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};

let stub: PathGitStub | null = null;
afterEach(() => {
  stub?.dispose();
  stub = null;
  vi.unstubAllEnvs();
});

describe('PATH-first git stub', () => {
  it('answers an intercepted invocation with the scripted stdout, stderr and exit code', () => {
    stub = installPathGitStub([{ argvPrefix: ['rev-parse', 'HEAD'], stdout: 'deadbeef\n', stderr: 'scripted\n', exitCode: 3 }]);
    expect(viaPath(['rev-parse', 'HEAD', '--verify'])).toEqual({ stdout: 'deadbeef\n', stderr: 'scripted\n', status: 3 });
  });

  it('matches the subcommand after git’s leading global options', () => {
    stub = installPathGitStub([{ argvPrefix: ['rev-parse', 'HEAD'], stdout: 'deadbeef\n', exitCode: 0 }]);
    const r = viaPath(['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', tmpdir(), 'rev-parse', 'HEAD']);
    expect(r).toEqual({ stdout: 'deadbeef\n', stderr: '', status: 0 });
  });

  it('delivers scripted output verbatim, shell metacharacters included', () => {
    const odd = `it's $(echo pwned) \`x\` "q"\n`;
    stub = installPathGitStub([{ argvPrefix: ['status'], stdout: odd, exitCode: 0 }]);
    expect(viaPath(['status']).stdout).toBe(odd);
  });

  it('passes a non-intercepted invocation to the real git', () => {
    const realVersion = viaPath(['--version']).stdout;
    const repo = mkdtempSync(join(tmpdir(), 'pathgitstub-'));
    try {
      stub = installPathGitStub([{ argvPrefix: ['rev-parse', 'HEAD'], stdout: 'deadbeef\n', exitCode: 0 }]);
      expect(viaPath(['--version']).stdout).toBe(realVersion);
      expect(viaPath(['init', '-q'], repo).status).toBe(0);
      expect(viaPath(['rev-parse', '--is-inside-work-tree'], repo).stdout).toBe('true\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('stops answering once the env is unstubbed, and dispose removes its bin dir', () => {
    const originalPath = process.env.PATH;
    stub = installPathGitStub([{ argvPrefix: ['help'], stdout: 'fake\n', exitCode: 0 }]);
    expect(viaPath(['help']).stdout).toBe('fake\n');
    const { binDir } = stub;
    stub.dispose();
    stub = null;
    vi.unstubAllEnvs();
    expect(process.env.PATH).toBe(originalPath);
    expect(existsSync(binDir)).toBe(false);
    expect(viaPath(['help']).stdout).not.toBe('fake\n');
  });

  it('runs an interception\'s script before its scripted answer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathgitstub-script-'));
    try {
      const marker = join(dir, "it's marked");
      stub = installPathGitStub([{ argvPrefix: ['rev-parse', 'HEAD'], script: `printf 'ran' > "${marker}"`, stdout: 'deadbeef\n', exitCode: 0 }]);
      expect(viaPath(['rev-parse', 'HEAD'])).toEqual({ stdout: 'deadbeef\n', stderr: '', status: 0 });
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : null).toBe('ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers through the real git after the script when the interception scripts no exit code', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pathgitstub-through-'));
    try {
      expect(viaPath(['init', '-q'], repo).status).toBe(0);
      const marker = join(repo, 'marker');
      stub = installPathGitStub([{ argvPrefix: ['rev-parse', '--is-inside-work-tree'], script: `printf 'ran' > "${marker}"` }]);
      expect(viaPath(['rev-parse', '--is-inside-work-tree'], repo)).toEqual({ stdout: 'true\n', stderr: '', status: 0 });
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : null).toBe('ran');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses an interception that neither scripts an exit code nor runs a script', () => {
    const originalPath = process.env.PATH;
    expect(() => installPathGitStub([{ argvPrefix: ['status'] } as unknown as GitInterception])).toThrow(RangeError);
    expect(process.env.PATH).toBe(originalPath);
  });

  it('refuses an exit code the shell cannot return, before touching PATH', () => {
    const originalPath = process.env.PATH;
    expect(() => installPathGitStub([{ argvPrefix: ['status'], exitCode: 256 }])).toThrow(RangeError);
    expect(() => installPathGitStub([{ argvPrefix: ['status'], exitCode: 1.5 }])).toThrow(RangeError);
    expect(process.env.PATH).toBe(originalPath);
  });
});
