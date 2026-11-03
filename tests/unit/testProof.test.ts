import { describe, expect, it } from 'vitest';
import { runTestProof, type OpenPullRequest, type TestProofPorts } from '../../src/main/testProof';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface World {
  dirty?: string[];
  head?: string;
  branch?: string | null;
  pr?: OpenPullRequest;
}

async function prove(args: string[], world: World = {}): Promise<{ exitCode: number; output: string; touched: string[] }> {
  const lines: string[] = [];
  const touched: string[] = [];
  const touch = (port: string) => touched.push(port);
  const branch = world.branch === undefined ? 'feature/proof' : world.branch;
  const ports: TestProofPorts = {
    workingTree: {
      dirtyPaths: async () => (touch('working tree'), world.dirty ?? []),
      head: async () => (touch('working tree'), world.head ?? HEAD),
      branch: async () => (touch('working tree'), branch),
    },
    pullRequests: {
      openFor: async (asked) => (touch('GitHub'), asked === branch ? (world.pr ?? { kind: 'open', number: 7, headSha: HEAD }) : { kind: 'none' }),
    },
    report: (line) => lines.push(line),
  };
  const exitCode = await runTestProof(args, ports);
  return { exitCode, output: lines.join('\n'), touched };
}

describe('runTestProof refuses every precondition before any suite', () => {
  it('refuses any argument, naming it, before reading the working tree or GitHub', async () => {
    const { exitCode, output, touched } = await prove(['unexpected-arg']);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain('unexpected-arg');
    expect.soft(touched).toEqual([]);
  });

  it('reports the argument when it is given alongside a dirty tree and no open PR', async () => {
    const { exitCode, output, touched } = await prove(['--grep=smoke'], { dirty: ['src/x.ts'], pr: { kind: 'none' } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain('--grep=smoke');
    expect.soft(touched).toEqual([]);
  });

  it('refuses a detached HEAD as not on a branch', async () => {
    const { exitCode, output } = await prove([], { branch: null });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not on a branch|detached/i);
  });

  it.each([
    ['an uncommitted change', 'src/changed.ts'],
    ['an untracked file', 'notes/untracked.md'],
  ])('refuses a dirty tree holding %s', async (_kind, path) => {
    const { exitCode, output } = await prove([], { dirty: [path] });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/dirty|uncommitted|untracked|not clean/i);
  });

  it('refuses when the branch has no open PR', async () => {
    const { exitCode, output } = await prove([], { pr: { kind: 'none' } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/no open (pull request|PR)/i);
  });

  it('refuses several open PRs, naming each', async () => {
    const { exitCode, output } = await prove([], { pr: { kind: 'several', numbers: [41, 58] } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/\b41\b/);
    expect.soft(output).toMatch(/\b58\b/);
  });

  it('refuses a fork-headed PR, naming it', async () => {
    const { exitCode, output } = await prove([], { pr: { kind: 'fork', number: 63 } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/fork/i);
    expect.soft(output).toMatch(/\b63\b/);
  });

  it.each([['gh is not installed (no gh on PATH)'], ['gh is not logged in (run gh auth login)']])('refuses when GitHub is unavailable, printing the reason: %s', async (reason) => {
    const { exitCode, output } = await prove([], { pr: { kind: 'github-unavailable', reason } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain(reason);
  });

  it('refuses a HEAD that is not the PR head, naming the PR, the local HEAD and the PR head', async () => {
    const { exitCode, output } = await prove([], { head: HEAD, pr: { kind: 'open', number: 7, headSha: OTHER } });
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not (the )?(PR|pull request)('s)? head|does not match|mismatch|differs/i);
    expect.soft(output).toMatch(/\b7\b/);
    expect.soft(output).toContain(HEAD);
    expect.soft(output).toContain(OTHER);
  });
});
