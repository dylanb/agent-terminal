import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commandEnvironment } from '../../src/main/appCommand';
import { join } from 'node:path';
import { runAdoptionStart, type AdoptionStartDeps } from '../../src/main/adoptionStart';
import { createRealAdoptionGit, createRealAdoptionGitHub } from '../../src/main/adoptionPorts';
import { clearAppLoopBootstrap, readPickupRecord, writeAdoptedPickup, writeAdoptedPickupIntent } from '../../src/main/appLoopState';
import { adoptedFixBranch, isAdoptedPickup } from '../../src/shared/appBootstrap';
import { createAdoptionWorld, type AdoptionWorld, type AdoptionWorldOptions } from '../helpers/adoptionWorld';
import type { StandInPull, StandInTicket } from '../helpers/adoptionGh';

// #304 — the adoption start's refusals that leave the operator's checkout as it was, through real git against the
// adoption world's bare origin and its gh stand-in.

const worlds: AdoptionWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

function world(pr?: AdoptionWorldOptions['pr']): AdoptionWorld {
  const w = createAdoptionWorld({ prefix: 'adoption-start', ...(pr === undefined ? {} : { pr }) });
  worlds.push(w);
  w.activate();
  // The operator's clone ignores the app's own state folder, as a repository using the app does.
  appendFileSync(join(w.repo, '.git', 'info', 'exclude'), '.agent-terminal/\n');
  return w;
}

const deps = (repo: string): AdoptionStartDeps => ({
  git: createRealAdoptionGit(repo),
  github: createRealAdoptionGitHub(repo),
  prepareRecord: (intent) => writeAdoptedPickupIntent(repo, intent),
  writeRecord: (pickup) => writeAdoptedPickup(repo, pickup),
  clearRecord: () => clearAppLoopBootstrap(repo),
});

const branches = (w: AdoptionWorld): string[] => w.git(w.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
const checkedOut = (w: AdoptionWorld): string => w.git(w.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
const reason = (r: Awaited<ReturnType<typeof runAdoptionStart>>): string => (r.ok ? 'started' : r.kind === 'error' ? r.error : r.kind);

describe('runAdoptionStart — the record it writes (#304)', () => {
  it("records the fork point of the PR as its base, not the base branch's tip once the base has moved on", async () => {
    const w = world();
    const movedTip = w.pushAs(w.baseBranch, 'later.txt', 'landed on the base after the PR branched\n', 'Move the base on');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toBe('started');
    const record = readPickupRecord(w.repo);
    const baseOid = record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.baseOid : record.kind;
    expect.soft(baseOid).toBe(w.startBaseOid);
    expect.soft(baseOid).not.toBe(movedTip);
  });
});

describe('runAdoptionStart — refusals that touch nothing (#304)', () => {
  it("refuses a PR whose head tracks the app's run state, naming the path, and keeps the app's own copy", async () => {
    const w = world();
    w.pushAs(w.headBranch, '.agent-terminal/loop/polish.yaml', 'step: planted\n', 'Plant run state');
    const own = join(w.repo, '.agent-terminal', 'loop', 'polish.yaml');
    mkdirSync(join(w.repo, '.agent-terminal', 'loop'), { recursive: true });
    writeFileSync(own, 'step: the-apps-own\n');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain('.agent-terminal/loop');
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(readFileSync(own, 'utf8')).toBe('step: the-apps-own\n');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it("refuses a PR that tracks the app's run state under another case of its folder name, naming it", async () => {
    const w = world();
    w.pushAs(w.headBranch, '.Agent-Terminal/LOOP/run-state.yaml', 'planted: true\n', 'Plant run state in another case');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain('.Agent-Terminal/LOOP');
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it("refuses a PR whose checkout would overwrite the app's own ignored state, which stays as it was", async () => {
    const w = world();
    w.pushAs(w.headBranch, '.agent-terminal/run-disposition.yaml', 'planted: true\n', 'Plant a run binding');
    const own = join(w.repo, '.agent-terminal', 'run-disposition.yaml');
    mkdirSync(join(w.repo, '.agent-terminal'), { recursive: true });
    writeFileSync(own, 'source: non-catalog\n');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(result.ok).toBe(false);
    expect.soft(reason(result)).toContain(adoptedFixBranch(w.prNumber, 1_700_000_000_000));
    expect.soft(reason(result)).toMatch(/ignored file/);
    expect.soft(readFileSync(own, 'utf8')).toBe('source: non-catalog\n');
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it("refuses a PR that tracks the app's state folder as a link, naming it, and keeps the app's own folder", async () => {
    const w = world();
    const run = (args: string[], input?: string): string =>
      execFileSync('git', args, { cwd: w.repo, encoding: 'utf8', env: commandEnvironment(w.env), ...(input === undefined ? {} : { input }) }).trim();
    run(['fetch', '-q', 'origin', `refs/pull/${w.prNumber}/head`]);
    const link = run(['hash-object', '-w', '--stdin'], 'evil');
    const tree = run(['mktree'], `${run(['ls-tree', 'FETCH_HEAD'])}\n120000 blob ${link}\t.agent-terminal\n`);
    const head = run(['commit-tree', tree, '-p', 'FETCH_HEAD', '-m', 'Link the state folder away']);
    run(['push', '-q', '--force', w.bareRemote, `${head}:refs/pull/${w.prNumber}/head`]);
    w.gh.update((state) => {
      const pr = state.pulls[0] as StandInPull;
      pr.headRefOid = head;
    });
    const own = join(w.repo, '.agent-terminal', 'flow-state.yaml');
    mkdirSync(join(w.repo, '.agent-terminal'), { recursive: true });
    writeFileSync(own, 'step: review\n');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain('.agent-terminal');
    expect.soft(readFileSync(own, 'utf8')).toBe('step: review\n');
    expect.soft(branches(w)).toEqual(['main']);
  });

  it("refuses a run whose fix branch already exists, keeping it, and names the way out: Terminate and start again", async () => {
    const w = world();
    const fixBranch = adoptedFixBranch(w.prNumber, 1_700_000_000_000);
    w.git(w.repo, ['branch', fixBranch]);
    const kept = w.git(w.repo, ['rev-parse', fixBranch]);

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain(fixBranch);
    expect.soft(reason(result)).toMatch(/Terminate the run and start it again/);
    expect.soft(w.git(w.repo, ['rev-parse', fixBranch])).toBe(kept);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it('reports a start whose rollback also fails as needing attention, naming the fix branch and both failures', async () => {
    const w = world();
    const git = createRealAdoptionGit(w.repo);
    const failing: AdoptionStartDeps = {
      ...deps(w.repo),
      git: {
        ...git,
        createAndCheckOut: async (branch, oid) => {
          await git.createAndCheckOut(branch, oid);
          throw new Error('the checkout was interrupted');
        },
        rollback: () => Promise.reject(new Error('the branch is locked')),
      },
    };

    const result = await runAdoptionStart(failing, { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(result.ok).toBe(false);
    expect.soft(!result.ok && result.kind === 'error' && result.requiresAttention).toBe(true);
    expect.soft(reason(result)).toContain('the checkout was interrupted');
    expect.soft(reason(result)).toContain('the branch is locked');
    expect.soft(reason(result)).toContain(adoptedFixBranch(w.prNumber, 1_700_000_000_000));
  });

  it('rolls a start that fails after checking out the fix branch back to the branch it started on, leaving no branch and no record', async () => {
    const w = world();
    const mainAt = w.git(w.repo, ['rev-parse', 'main']);
    const git = createRealAdoptionGit(w.repo);
    const failing: AdoptionStartDeps = {
      ...deps(w.repo),
      git: {
        ...git,
        createAndCheckOut: async (branch, oid) => {
          await git.createAndCheckOut(branch, oid);
          throw new Error('the checkout was interrupted');
        },
      },
    };

    const result = await runAdoptionStart(failing, { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain('the checkout was interrupted');
    expect.soft(w.git(w.repo, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect.soft(w.git(w.repo, ['rev-parse', 'main'])).toBe(mainAt);
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it('rolls a start made from a detached HEAD back to that commit, leaving no branch and no record', async () => {
    const w = world();
    w.git(w.repo, ['checkout', '--detach', 'main']);
    const startCommit = w.git(w.repo, ['rev-parse', 'HEAD']);
    const git = createRealAdoptionGit(w.repo);
    const failing: AdoptionStartDeps = {
      ...deps(w.repo),
      git: {
        ...git,
        createAndCheckOut: async (branch, oid) => {
          await git.createAndCheckOut(branch, oid);
          throw new Error('the checkout was interrupted');
        },
      },
    };

    const result = await runAdoptionStart(failing, { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toContain('the checkout was interrupted');
    expect.soft(checkedOut(w)).toBe('HEAD');
    expect.soft(w.git(w.repo, ['rev-parse', 'HEAD'])).toBe(startCommit);
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it('refuses a working tree with uncommitted changes, creating no branch and no record', async () => {
    const w = world();
    writeFileSync(join(w.repo, 'README.md'), 'an uncommitted edit\n');

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toMatch(/not clean/);
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(readFileSync(join(w.repo, 'README.md'), 'utf8')).toBe('an uncommitted edit\n');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it.each<[string, (pr: StandInPull) => void, RegExp]>([
    ['GitHub reports no head repository (a deleted fork)', (pr) => { pr.headRepo = null; }, /no head repository/],
    ['its head repository is a name the record cannot hold', (pr) => { pr.headRepo = 'owner/..'; }, /head repository owner\/\.\. is not a repository name/],
    ['its base branch is a name the record cannot hold', (pr) => { pr.baseRefName = 'base+name'; }, /base branch base\+name is not a branch name/],
    ['GitHub reports a state that is not open', (pr) => { (pr as { state: string }).state = 'DRAFTED'; }, /not open/],
  ])('refuses a PR when %s, creating no branch', async (_case, edit, why) => {
    const w = world();
    w.gh.update((state) => edit(state.pulls[0] as StandInPull));

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toMatch(why);
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });
});

describe('runAdoptionStart — the primary ticket of a PR that closes several (#304 AC 4)', () => {
  const ORIGIN_TICKET: StandInTicket = { repo: 'owner/repo', number: 176 };
  const FORK_TICKET: StandInTicket = { repo: 'contributor/fork', number: 177 };
  const twoTickets = (): AdoptionWorld => world({ fork: 'Contributor/Fork', closingIssues: [ORIGIN_TICKET, FORK_TICKET] });
  const recorded = (w: AdoptionWorld): unknown => {
    const record = readPickupRecord(w.repo);
    return record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? { primary: record.bootstrap.primary, tickets: record.bootstrap.tickets } : record.kind;
  };
  const offered = (r: Awaited<ReturnType<typeof runAdoptionStart>>): unknown => (r.ok ? 'started' : 'tickets' in r ? r.tickets : r.error);
  const byNumber = (tickets: unknown): unknown =>
    Array.isArray(tickets) ? [...(tickets as Array<{ number: number }>)].sort((a, b) => a.number - b.number) : tickets;

  it('asks which ticket is the primary, offering each acceptable one with its repository, and touches nothing', async () => {
    const w = twoTickets();

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(result).toMatchObject({ ok: false, kind: 'choose-ticket' });
    expect.soft(byNumber(offered(result))).toEqual([ORIGIN_TICKET, FORK_TICKET]);
    expect.soft(branches(w)).toEqual(['main']);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  });

  it("starts with the operator's pick as the primary, and keeps every acceptable ticket", async () => {
    const w = twoTickets();

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000, pick: FORK_TICKET });

    expect.soft(reason(result)).toBe('started');
    const record = recorded(w) as { primary?: unknown; tickets?: unknown };
    expect.soft(record.primary).toEqual(FORK_TICKET);
    expect.soft(byNumber(record.tickets)).toEqual([ORIGIN_TICKET, FORK_TICKET]);
  });

  // The PR closes one acceptable ticket, so the start runs today: only refusing the pick tells these apart.
  const UNACCEPTABLE: Array<{ title: string; closes: StandInTicket[]; pick: StandInTicket }> = [
    { title: 'a ticket the PR does not close', closes: [ORIGIN_TICKET], pick: { repo: 'owner/repo', number: 999 } },
    { title: 'a ticket the PR closes outside its base and head repositories', closes: [ORIGIN_TICKET, { repo: 'elsewhere/other', number: 9 }], pick: { repo: 'elsewhere/other', number: 9 } },
    { title: "a closed ticket's number in the head repository, where the PR closes no such ticket", closes: [ORIGIN_TICKET], pick: { repo: 'contributor/fork', number: 176 } },
  ];
  for (const row of UNACCEPTABLE) {
    it(`refuses a pick of ${row.title}, naming it, and touches nothing`, async () => {
      const w = world({ fork: 'Contributor/Fork', closingIssues: row.closes });

      const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000, pick: row.pick });

      expect.soft(reason(result)).toMatch(new RegExp(`(^|\\D)${row.pick.number}(\\D|$)`));
      expect.soft(reason(result)).toContain(row.pick.repo);
      expect.soft(branches(w)).toEqual(['main']);
      expect.soft(checkedOut(w)).toBe('main');
      expect.soft(readPickupRecord(w.repo).kind).toBe('none');
    });
  }

  it('starts a PR that closes one acceptable ticket with it as the primary, asking nothing', async () => {
    const w = world({ fork: 'Contributor/Fork', closingIssues: [FORK_TICKET, { repo: 'elsewhere/other', number: 9 }] });

    const result = await runAdoptionStart(deps(w.repo), { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toBe('started');
    expect.soft(recorded(w)).toEqual({ primary: FORK_TICKET, tickets: [FORK_TICKET] });
  });
});

describe("runAdoptionStart — origin's host (#304 AC 6)", () => {
  it("records origin's own host, which every ticket's gh instruction names", async () => {
    const w = world();
    const real = createRealAdoptionGitHub(w.repo);
    const onEnterprise: AdoptionStartDeps = {
      ...deps(w.repo),
      github: {
        origin: async () => ({ selector: 'ghe.example.com/owner/repo', owner: 'owner', name: 'repo', defaultBranch: 'main' }),
        pullRequest: async (n) => {
          const pr = await real.pullRequest(n);
          return { ...pr, closingIssues: pr.closingIssues.map((i) => ({ ...i, url: i.url.replace(/^https:\/\/github\.com\//, 'https://ghe.example.com/') })) };
        },
      },
    };

    const result = await runAdoptionStart(onEnterprise, { pr: w.prNumber, startedAt: 1_700_000_000_000 });

    expect.soft(reason(result)).toBe('started');
    const record = readPickupRecord(w.repo);
    expect.soft(record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.host : record.kind).toBe('ghe.example.com');
  });
});
