import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealAppEpicPromotionGitHub } from '../../src/main/appEpicPromotionGithub';
import { createGitHubRepositorySource } from '../../src/main/githubRepository';

// §28.7 — the real gh adapter, driven against a fake `gh` on PATH (mirrors bootstrapPorts.test.ts). Pins the two
// net-new safety branches (createIssue's null-URL refusal, appendIssueBody's empty-read refusal) and the CWE-78
// controls (`--repo <selector>` on every mutation, an inherited GH_REPO dropped).

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const readIf = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

describe('createRealAppEpicPromotionGitHub — gh adapter', () => {
  let root: string;
  let repo: string;
  let log: string;
  let saved: { path?: string; log?: string; ghRepo?: string; createOut?: string; body?: string };

  function writeFakeGh(): void {
    writeFileSync(
      join(root, 'gh'),
      '#!/usr/bin/env bash\n' +
        'printf \'%s GH_REPO=%s\\n\' "$*" "${GH_REPO-unset}" >> "$FAKE_GH_LOG"\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then cat > "$FAKE_GH_LOG.create-body"; printf \'%s\\n\' "${FAKE_CREATE_OUT:-https://github.com/owner/repository/issues/501}"; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then printf \'%s\\n\' "${FAKE_BODY-existing epic body}"; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then cat > "$FAKE_GH_LOG.edit"; exit 0; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'epic-promote-gh-'));
    repo = join(root, 'repo');
    log = join(root, 'gh.log');
    mkdirSync(repo);
    runGit(repo, ['init']);
    runGit(repo, ['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
    writeFakeGh();
    saved = { path: process.env.PATH, log: process.env.FAKE_GH_LOG, ghRepo: process.env.GH_REPO, createOut: process.env.FAKE_CREATE_OUT, body: process.env.FAKE_BODY };
    process.env.PATH = `${root}:${saved.path ?? ''}`;
    process.env.FAKE_GH_LOG = log;
    process.env.GH_REPO = 'attacker/other';
    delete process.env.FAKE_CREATE_OUT;
    delete process.env.FAKE_BODY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({ PATH: saved.path, FAKE_GH_LOG: saved.log, GH_REPO: saved.ghRepo, FAKE_CREATE_OUT: saved.createOut, FAKE_BODY: saved.body })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const adapter = () => createRealAppEpicPromotionGitHub(repo, createGitHubRepositorySource(repo));

  it('createIssue returns the parsed number, sends the body on stdin, and pins --repo (dropping GH_REPO)', async () => {
    const issue = await adapter().createIssue('A title', 'the sub-ticket body');
    expect(issue).toBe(501);
    expect(readIf(`${log}.create-body`)).toContain('the sub-ticket body'); // body via stdin, not argv
    const line = readIf(log).split('\n').find((l) => l.startsWith('issue create'))!;
    expect(line).toContain('--repo github.com/owner/repository');
    expect(line).toContain('GH_REPO=unset'); // the inherited attacker GH_REPO is dropped
  });

  it('createIssue refuses an unrecognized create outcome (fail closed, not a bogus 0)', async () => {
    process.env.FAKE_CREATE_OUT = 'not a url';
    await expect(adapter().createIssue('t', 'b')).rejects.toThrow(/not recognized/);
  });

  it('appendIssueBody preserves the existing body as a prefix', async () => {
    process.env.FAKE_BODY = 'ORIGINAL BODY';
    await adapter().appendIssueBody(176, '\n\nMARKER\n## Sub-tickets\n- [ ] #501 — A', 'MARKER');
    const written = readIf(`${log}.edit`);
    expect(written.startsWith('ORIGINAL BODY')).toBe(true);
    expect(written).toContain('- [ ] #501 — A');
  });

  it('appendIssueBody is idempotent — skips when the body already carries the marker (never double-appends)', async () => {
    process.env.FAKE_BODY = 'ORIGINAL BODY\n\nMARKER\n## Sub-tickets\n- [ ] #501 — A';
    await adapter().appendIssueBody(176, '\n\nMARKER\n## Sub-tickets\n- [ ] #501 — A', 'MARKER');
    expect(readIf(`${log}.edit`)).toBe(''); // the marker is present → no second edit issued
  });

  it('appendIssueBody refuses an empty read — never clobbers the human intent, issues no edit (§27.10)', async () => {
    process.env.FAKE_BODY = '';
    await expect(adapter().appendIssueBody(176, 'the checklist', 'MARKER')).rejects.toThrow(/empty epic issue body/);
    expect(readIf(`${log}.edit`)).toBe(''); // no `issue edit --body-file` was ever issued
  });

  it('closePr pins --repo', async () => {
    await adapter().closePr(4242);
    const line = readIf(log).split('\n').find((l) => l.startsWith('pr close'))!;
    expect(line).toContain('--repo github.com/owner/repository');
  });
});
