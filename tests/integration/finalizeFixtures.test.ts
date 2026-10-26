import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { seedFinalizeGit, seedScriptedGh } from '../helpers/finalizeFixtures';

let fx: GitRepoFixture;
beforeEach(() => { fx = createGitRepoFixture(); });
afterEach(() => fx.cleanup());

describe('finalize infrastructure (#251)', () => {
  it('requires resolving the actual non-default target before committing and pushing', () => {
    const { repo, remote, base, head } = seedFinalizeGit(fx);
    expect(base).not.toBe('main');
    const before = fx.git(remote, ['rev-parse', head]);
    fx.git(repo, ['merge', '--no-edit', 'origin/main']);
    expect(fx.git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(() => fx.git(repo, ['merge', '--no-edit', `origin/${base}`])).toThrow();
    expect(fx.git(repo, ['diff', '--name-only', '--diff-filter=U'])).toBe('policy.txt');
    fx.writeRepoFile(repo, 'policy.txt', 'approved resolution\n');
    const resolved = fx.commitAll(repo, 'Resolve approved intent');
    expect(resolved).not.toBe(before);
    fx.git(repo, ['push', 'origin', head]);
    expect(fx.git(remote, ['rev-parse', head])).toBe(resolved);
    expect(fx.git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('serves controlled revision/check responses and captures publication bytes without invoking GitHub', () => {
    const root = fx.makeGitRepo('finalize-gh');
    const gh = seedScriptedGh(root);
    const view = ['pr', 'view', '251', '--repo', 'fixture/repo', '--json', 'headRefOid'];
    const checks = ['pr', 'checks', '251', '--repo', 'fixture/repo'];
    const edit = ['pr', 'edit', '251', '--repo', 'fixture/repo', '--body-file', '-'];
    gh.script([
      { args: view, stdout: '{"headRefOid":"old"}' },
      { args: checks, stdout: 'pending', exitCode: 8 },
      { args: view, stdout: '{"headRefOid":"new"}' },
      { args: checks, stderr: 'unavailable', exitCode: 1 },
      { args: edit, stderr: 'publication failed', exitCode: 1 },
      { args: edit },
    ]);
    const run = (args: string[], input = '') => spawnSync(gh.command, args, { input, encoding: 'utf8' });
    expect(run(view).stdout).toBe('{"headRefOid":"old"}');
    expect(run(checks).status).toBe(8);
    expect(run(view).stdout).toBe('{"headRefOid":"new"}');
    expect(run(checks).stderr).toBe('unavailable');
    const body = 'Closes #251\n\nAudit: `literal` $(never-run)\n';
    expect(run(edit, body).status).toBe(1);
    expect(run(edit, body).status).toBe(0);
    expect(gh.calls().slice(-2).map((call) => call.stdin)).toEqual([body, body]);
    expect(run(checks).status).not.toBe(0);
    expect(existsSync(join(root, 'never-run'))).toBe(false);
  });

  it('rejects unexpected commands without consuming the expected response', () => {
    const gh = seedScriptedGh(fx.makeGitRepo('finalize-gh-reject'));
    gh.script([{ args: ['pr', 'view', '251'], stdout: 'expected' }]);
    const run = (args: string[]) => spawnSync(gh.command, args, { encoding: 'utf8' });
    expect(run(['pr', 'merge', '251']).status).not.toBe(0);
    expect(run(['pr', 'view', '251']).stdout).toBe('expected');
    expect(gh.calls().map((call) => call.args)).toEqual([['pr', 'merge', '251'], ['pr', 'view', '251']]);
  });
});
