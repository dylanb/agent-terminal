import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppGateGitHub } from '../../src/main/appGateGithub';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const begin = '<!-- agent-terminal:flow-audit:start -->';
const end = '<!-- agent-terminal:flow-audit:end -->';
const original = '# Implementation\n\nOperator context remains.\n\nCloses #251\n';
const report = '# Flow audit\n\nDevelopment complete; finalization verified. Human completion and merge remain.\n';
const maintained = (text: string) => `${begin}\n${text}${end}`;

function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-audit-'));
  dirs.push(dir);
  const artifact = join(dir, 'flow-audit.md');
  writeFileSync(artifact, report);
  let published = body;
  const targets: number[] = [];
  const github = {
    pullRequest: async (number: number) => ({ number, branch: 'feature-251', state: 'OPEN' as const, closingIssues: [251], crossRepository: false }),
    pullRequestBody: async (number: number) => {
      targets.push(number);
      return published;
    },
    markPullRequestReady: async () => { throw new Error('must not change draft state'); },
    updateIssueBody: async () => { throw new Error('must not update an issue'); },
    publishPullRequestBody: async (number: number, bodyFile: string) => {
      targets.push(number);
      published = readFileSync(bodyFile, 'utf8');
    },
  };
  const run = createAppGateGitHub(github);
  return {
    artifact,
    body: () => published,
    targets,
    publish: () => run('publish-flow-audit', { pr: 41, ticket: 251, bodyFile: artifact, bootstrap: null })
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
  };
}

describe('#251 maintained audit publication', () => {
  it('appends the local report below the retained description and closing reference', async () => {
    const fx = fixture(original);
    expect.soft(await fx.publish()).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(`${original}\n${maintained(report)}\n`);
    expect.soft(fx.targets.length).toBeGreaterThan(0);
    expect(fx.targets.every((number) => number === 41)).toBe(true);
  });

});
