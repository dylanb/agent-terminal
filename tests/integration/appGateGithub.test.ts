import { describe, expect, it } from 'vitest';
import { createAppGateGitHub } from '../../src/main/appGateGithub';

// §27.13 / N5 — the §27 approve side-effect port maps the declared `gh` action + the refs it acts on to a
// STRUCTURED gh argv (CWE-78: every value a distinct element, never a shell string). The domain runner is
// injected so the mapping is asserted without shelling a real `gh` (the real path is e2e). A missing required
// input is a best-effort FAILURE (throw), never a malformed call.

const captured = (
  responses: string[] = [],
): {
  argvs: string[][];
  stdins: Array<string | undefined>;
  run: (argv: string[], stdin?: string) => Promise<string>;
} => {
  const argvs: string[][] = [];
  const stdins: Array<string | undefined> = [];
  return {
    argvs,
    stdins,
    run: async (argv, stdin) => {
      argvs.push(argv);
      stdins.push(stdin);
      return responses.shift() ?? '';
    },
  };
};

describe('§27 approve side-effect port (appGateGithub)', () => {
  it('mark-ready flips the PR non-draft via `gh pr ready <pr>` (§27.13 plan approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('mark-ready', {
      pr: 42,
      ticket: null,
      bodyFile: null,
      bootstrap: null,
    });
    expect(c.argvs).toEqual([['pr', 'ready', '42']]);
  });

  it('update-issue-body publishes the body artifact to the issue via `gh issue edit <n> --body-file` (§27.13 groom approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: 7, bodyFile: '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md', bootstrap: null });
    expect(c.argvs).toEqual([['issue', 'edit', '7', '--body-file', '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md']]);
  });

  it('publishes a restarted groom result without consulting a stale bootstrap PR', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('update-issue-body', {
      pr: 42,
      ticket: 78,
      bodyFile: '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md',
      bootstrap: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
      },
    });
    expect(c.argvs).toEqual([
      [
        'issue',
        'edit',
        '78',
        '--body-file',
        '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md',
      ],
    ]);
  });

  it('publish-pr-body publishes the body artifact to the PR via `gh pr edit <n> --body-file` (§27.13 impl approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('publish-pr-body', { pr: 99, ticket: null, bodyFile: '/repo/.agent-terminal/loop/artifacts/plan.md', bootstrap: null });
    expect(c.argvs).toEqual([['pr', 'edit', '99', '--body-file', '/repo/.agent-terminal/loop/artifacts/plan.md']]);
  });

  it('fails best-effort (throws, issues no call) when a required input is absent', async () => {
    const c = captured();
    await expect(createAppGateGitHub(c.run)('mark-ready', { pr: null, ticket: null, bodyFile: null, bootstrap: null })).rejects.toThrow(/no PR/);
    await expect(createAppGateGitHub(c.run)('publish-pr-body', { pr: 5, ticket: null, bodyFile: null, bootstrap: null })).rejects.toThrow(/body artifact/);
    await expect(createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: null, bodyFile: '/x', bootstrap: null })).rejects.toThrow(/no issue/);
    await expect(createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: 7, bodyFile: null, bootstrap: null })).rejects.toThrow(/body artifact/);
    await expect(createAppGateGitHub(c.run)('publish-pr-body', { pr: null, ticket: null, bodyFile: '/x', bootstrap: null })).rejects.toThrow(/no PR/);
    expect(c.argvs).toEqual([]); // no malformed gh call was issued
  });

  it('rejects an unknown action rather than issuing an arbitrary gh call', async () => {
    const c = captured();
    await expect(createAppGateGitHub(c.run)('rm-rf', { pr: 1, ticket: 1, bodyFile: '/x', bootstrap: null })).rejects.toThrow(/unknown approve side-effect action/);
    expect(c.argvs).toEqual([]);
  });

  it('verifies a persisted bootstrap PR belongs to its issue and head branch before mutation', async () => {
    const c = captured([
      JSON.stringify({
        number: 42,
        headRefName: 'plan-loop/issue-78',
        state: 'OPEN',
        closingIssuesReferences: [{ number: 78 }],
      }),
    ]);

    await createAppGateGitHub(c.run)('mark-ready', {
      pr: 42,
      ticket: 78,
      bodyFile: null,
      bootstrap: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
      },
    });

    expect(c.argvs).toEqual([
      [
        'pr',
        'view',
        '42',
        '--json',
        'number,headRefName,state,closingIssuesReferences',
      ],
      ['pr', 'ready', '42'],
    ]);
  });

  it('keeps the bootstrap issue-closing relationship when publishing the implementation body', async () => {
    const c = captured([
      JSON.stringify({
        number: 42,
        headRefName: 'plan-loop/issue-78',
        state: 'OPEN',
        closingIssuesReferences: [{ number: 78 }],
      }),
      '',
    ]);

    await createAppGateGitHub(
      c.run,
      async () => '# Implementation summary\n',
    )('publish-pr-body', {
      pr: 42,
      ticket: 78,
      bodyFile: '/repo/.agent-terminal/loop/artifacts/plan.md',
      bootstrap: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
      },
    });

    expect(c.argvs).toEqual([
      [
        'pr',
        'view',
        '42',
        '--json',
        'number,headRefName,state,closingIssuesReferences',
      ],
      ['pr', 'edit', '42', '--body-file', '-'],
    ]);
    expect(c.stdins).toEqual([
      undefined,
      '# Implementation summary\n\ncloses #78\n',
    ]);
  });

  it('refuses a tampered persisted bootstrap identity before any outward mutation', async () => {
    const c = captured([
      JSON.stringify({
        number: 42,
        headRefName: 'other/branch',
        state: 'OPEN',
        closingIssuesReferences: [{ number: 999 }],
      }),
    ]);

    await expect(
      createAppGateGitHub(c.run)('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        bootstrap: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
        },
      }),
    ).rejects.toThrow(/bootstrap PR identity/i);

    expect(c.argvs).toEqual([
      [
        'pr',
        'view',
        '42',
        '--json',
        'number,headRefName,state,closingIssuesReferences',
      ],
    ]);
  });
});
