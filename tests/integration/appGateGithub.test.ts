import { describe, expect, it } from 'vitest';
import { createAppGateGitHub } from '../../src/main/appGateGithub';

// §27.13 / N5 — the §27 approve side-effect port maps the declared `gh` action + the refs it acts on to a
// STRUCTURED gh argv (CWE-78: every value a distinct element, never a shell string). The domain runner is
// injected so the mapping is asserted without shelling a real `gh` (the real path is e2e). A missing required
// input is a best-effort FAILURE (throw), never a malformed call.

const captured = (): { argvs: string[][]; run: (argv: string[]) => Promise<void> } => {
  const argvs: string[][] = [];
  return { argvs, run: async (argv) => void argvs.push(argv) };
};

describe('§27 approve side-effect port (appGateGithub)', () => {
  it('mark-ready flips the PR non-draft via `gh pr ready <pr>` (§27.13 plan approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('mark-ready', { pr: 42, ticket: null, bodyFile: null });
    expect(c.argvs).toEqual([['pr', 'ready', '42']]);
  });

  it('update-issue-body publishes the body artifact to the issue via `gh issue edit <n> --body-file` (§27.13 groom approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: 7, bodyFile: '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md' });
    expect(c.argvs).toEqual([['issue', 'edit', '7', '--body-file', '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md']]);
  });

  it('publish-pr-body publishes the body artifact to the PR via `gh pr edit <n> --body-file` (§27.13 impl approve)', async () => {
    const c = captured();
    await createAppGateGitHub(c.run)('publish-pr-body', { pr: 99, ticket: null, bodyFile: '/repo/.agent-terminal/loop/artifacts/diff.md' });
    expect(c.argvs).toEqual([['pr', 'edit', '99', '--body-file', '/repo/.agent-terminal/loop/artifacts/diff.md']]);
  });

  it('fails best-effort (throws, issues no call) when a required input is absent', async () => {
    const c = captured();
    await expect(createAppGateGitHub(c.run)('mark-ready', { pr: null, ticket: null, bodyFile: null })).rejects.toThrow(/no PR/);
    await expect(createAppGateGitHub(c.run)('publish-pr-body', { pr: 5, ticket: null, bodyFile: null })).rejects.toThrow(/body artifact/);
    await expect(createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: null, bodyFile: '/x' })).rejects.toThrow(/no issue/);
    await expect(createAppGateGitHub(c.run)('update-issue-body', { pr: null, ticket: 7, bodyFile: null })).rejects.toThrow(/body artifact/);
    await expect(createAppGateGitHub(c.run)('publish-pr-body', { pr: null, ticket: null, bodyFile: '/x' })).rejects.toThrow(/no PR/);
    expect(c.argvs).toEqual([]); // no malformed gh call was issued
  });

  it('rejects an unknown action rather than issuing an arbitrary gh call', async () => {
    const c = captured();
    await expect(createAppGateGitHub(c.run)('rm-rf', { pr: 1, ticket: 1, bodyFile: '/x' })).rejects.toThrow(/unknown approve side-effect action/);
    expect(c.argvs).toEqual([]);
  });
});
