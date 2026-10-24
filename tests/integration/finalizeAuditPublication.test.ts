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

function fixture(body: string, options: { reject?: boolean; discard?: boolean; readbackError?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-audit-'));
  dirs.push(dir);
  const artifact = join(dir, 'flow-audit.md');
  writeFileSync(artifact, report);
  let published = body;
  const targets: number[] = [];
  const writes: string[] = [];
  const github = {
    pullRequest: async (number: number) => ({ number, branch: 'feature-251', state: 'OPEN' as const, closingIssues: [251], crossRepository: false }),
    pullRequestBody: async (number: number) => {
      targets.push(number);
      if (writes.length && options.readbackError) throw new Error('readback unavailable');
      return published;
    },
    markPullRequestReady: async () => { throw new Error('must not change draft state'); },
    updateIssueBody: async () => { throw new Error('must not update an issue'); },
    publishPullRequestBody: async (number: number, bodyFile: string) => {
      targets.push(number);
      if (options.reject) throw new Error('publication rejected');
      const text = readFileSync(bodyFile, 'utf8');
      writes.push(text);
      if (!options.discard) published = text;
    },
  };
  const run = createAppGateGitHub(github);
  return {
    artifact,
    body: () => published,
    targets,
    writes,
    options,
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

  it('replaces the prior section and moves it below preserved trailing context on repeated publication', async () => {
    const suffix = '\nOperator follow-up.\nCloses #999\n';
    const fx = fixture(`${original}\n${maintained('Old evidence\n')}${suffix}`);
    const expected = `${original}\n${suffix}\n${maintained(report)}\n`;
    expect.soft(await fx.publish()).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(expected);
    writeFileSync(fx.artifact, 'Updated evidence\n');
    expect.soft(await fx.publish()).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(`${original}\n${suffix}\n${maintained('Updated evidence\n')}\n`);
  });

  it.each([
    `${begin}\nunterminated`,
    `orphan ${end}`,
    `${end}\n${begin}`,
    `${maintained('one')}\n${maintained('two')}`,
    `${begin}\n${begin}\nnested\n${end}\n${end}`,
  ])('refuses ambiguous ownership without changing remote content: %s', async (owned) => {
    const body = `${original}\n${owned}`;
    const fx = fixture(body);
    expect.soft(await fx.publish()).toEqual({ error: expect.any(String) });
    expect.soft(fx.body()).toBe(body);
    expect.soft(fx.writes).toEqual([]);
  });

  it('surfaces a rejected write and permits retry against the unchanged description', async () => {
    const fx = fixture(original, { reject: true });
    expect(await fx.publish()).toEqual({ error: 'publication rejected' });
    expect(fx.body()).toBe(original);
    fx.options.reject = false;
    expect(await fx.publish()).toEqual({ outcome: 'done' });
    expect(fx.body()).toBe(`${original}\n${maintained(report)}\n`);
  });

  it.each([{ discard: true }, { readbackError: true }])('does not claim success without matching remote readback: %j', async (options) => {
    const fx = fixture(original, options);
    expect.soft(await fx.publish()).toEqual({ error: expect.any(String) });
    expect(fx.writes).toHaveLength(1);
  });
});


describe('#251 publication artifact ownership', () => {
  it.each([begin, end])('rejects a report containing the reserved delimiter %s before writing', async (marker) => {
    const fx = fixture(original);
    writeFileSync(fx.artifact, `Report containing ${marker}\n`);
    expect(await fx.publish()).toEqual({ error: expect.any(String) });
    expect(fx.body()).toBe(original);
    expect(fx.writes).toEqual([]);
  });
});
