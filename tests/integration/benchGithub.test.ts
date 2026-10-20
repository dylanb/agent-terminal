import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { readFakeGhIssue, seedFakeGhGit, seedFakeGhIssue, seedFakeGhLabels, type FakeGhIssue } from '../e2e/fakeTools';
import { createBenchGithub } from '../../src/main/benchGithub';

// #180 — the real BenchGithub against the PATH-first fake `gh`, over real git.

let b: BenchFixtureBuilder;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  b?.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The fake `gh` first on PATH, logging to the returned file. */
function fakeGh(env: Record<string, string> = {}): string {
  const { binDir, ghOnlyBinDir, logFile } = seedFakeGhGit('bench-gh-');
  dirs.push(binDir);
  vi.stubEnv('PATH', `${ghOnlyBinDir}:${process.env.PATH}`);
  vi.stubEnv('FAKE_GHGIT_LOG', logFile);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return logFile;
}

/** Every `gh` call the fake logged; none when it was never called. */
const ghCalls = (logFile: string): string[] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('gh '))
    : [];

const REPOSITORY = 'github.com/fake/repo';

/** Whether a logged `gh issue|pr <sub> …` call other than a view names issue `n` as a positional, wherever it
 *  sits among the flags; every flag the adapter passes takes a value. */
function writesTo(call: string, n: number): boolean {
  const [, kind, sub, ...rest] = call.split(' ');
  if ((kind !== 'issue' && kind !== 'pr') || sub === 'view') return false;
  const positionals = rest.filter((t, i) => !t.startsWith('-') && !(rest[i - 1]?.startsWith('-') && !rest[i - 1].includes('=')));
  return positionals.includes(String(n));
}

const SOURCE: FakeGhIssue = {
  number: 180,
  title: 'Bench-1: re-run a span',
  body: 'The intent.\n\nSee #178 and @someone.\n',
  labels: ['agent-loop/ready', 'area/bench'],
  comments: [
    { author: 'octocat', createdAt: '2026-01-02T03:04:05Z', body: 'First comment, cc @hubot.\nSecond line.' },
    { author: 'hubot', createdAt: '2026-01-03T04:05:06Z', body: 'Second comment.' },
  ],
};

describe('the real BenchGithub', () => {
  it('names the GitHub repository a folder belongs to by its selector', async () => {
    b = createBenchFixtureBuilder();
    const { dir } = b.makeRepository('bench-gh-repo');
    fakeGh();

    expect(await createBenchGithub().repositoryOf(dir)).toBe('github.com/fake/repo');
  });

  it('copies an issue: its title and body, its labels but agent-loop/ready plus bench-run, its comments in order under an author line', async () => {
    const log = fakeGh();
    seedFakeGhIssue(log, SOURCE);

    const copy = readFakeGhIssue(log, await createBenchGithub().copyIssue({ repository: REPOSITORY, number: SOURCE.number }));

    const comments = (copy?.comments ?? []).map((c) => {
      const [first] = c.body.split('\n');
      return { first, rest: c.body.slice(first.length) };
    });
    expect({ title: copy?.title, body: copy?.body, labels: [...(copy?.labels ?? [])].sort(), comments }).toEqual({
      title: SOURCE.title,
      body: SOURCE.body,
      labels: ['area/bench', 'bench-run'],
      comments: SOURCE.comments.map((c) => ({
        first: expect.stringMatching(new RegExp(`^(?=[^@]*$)(?=.*\\b${c.author}\\b)(?=.*${c.createdAt}).*$`)),
        rest: `\n\n${c.body}`,
      })),
    });
  });

  it('pins every call of a copy to the repository and writes nothing to the source issue', async () => {
    const log = fakeGh();
    seedFakeGhIssue(log, SOURCE);

    await createBenchGithub().copyIssue({ repository: REPOSITORY, number: SOURCE.number });

    const calls = ghCalls(log);
    expect({
      called: calls.length > 0,
      unpinned: calls.filter((c) => !c.includes(`--repo ${REPOSITORY}`)),
      sourceWrites: calls.filter((c) => writesTo(c, SOURCE.number)),
      source: readFakeGhIssue(log, SOURCE.number),
    }).toEqual({ called: true, unpinned: [], sourceWrites: [], source: SOURCE });
  });

  it('creates a missing bench-run label with a description naming a Bench-1 issue copy', async () => {
    const log = fakeGh();

    const result = await createBenchGithub().ensureBenchRunLabel(REPOSITORY);

    const calls = ghCalls(log);
    expect({ result, creates: calls.filter((c) => c.startsWith('gh label create')), unpinned: calls.filter((c) => !c.includes(`--repo ${REPOSITORY}`)) }).toEqual({
      result: 'created',
      creates: [expect.stringMatching(new RegExp(`^gh label create bench-run (?=.*--description .*Bench-1)(?=.*--repo ${REPOSITORY}\\b)`))],
      unpinned: [],
    });
  });

  it('uses an existing bench-run label as it is: no create, no edit', async () => {
    const log = fakeGh();
    seedFakeGhLabels(log, ['agent-loop/ready', 'bench-run']);

    const result = await createBenchGithub().ensureBenchRunLabel(REPOSITORY);

    const calls = ghCalls(log);
    expect({ result, changes: calls.filter((c) => /^gh label (create|edit)\b/.test(c)), unpinned: calls.filter((c) => !c.includes(`--repo ${REPOSITORY}`)) }).toEqual({
      result: 'existed',
      changes: [],
      unpinned: [],
    });
  });

  it('answers failed when the label is missing and cannot be created', async () => {
    fakeGh({ FAKE_GH_LABEL_CREATE_FAIL: '1' });

    expect(await createBenchGithub().ensureBenchRunLabel(REPOSITORY)).toBe('failed');
  });
});
