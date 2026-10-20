import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createControllerFixture } from '../helpers/controllerFixture';

const fixtures: ReturnType<typeof createControllerFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

it('owns isolated state, real equal-basename repositories and worktrees without changing HOME', () => {
  const a = createControllerFixture(); fixtures.push(a);
  const b = createControllerFixture(); fixtures.push(b);
  expect(a.home).not.toBe(b.home);
  expect(a.env.HOME).toBe(process.env.HOME);
  expect(a.env.APP_HOME_DIR).toBe(a.home);
  expect(existsSync(a.home)).toBe(false);
  expect(a.repositories.map(p => p.split('/').at(-1))).toEqual(['project', 'project']);
  for (const dir of [...a.repositories, ...a.worktrees]) {
    expect(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: a.env, encoding: 'utf8' }).trim()).toBe(dir);
  }
  expect(readFileSync(`${a.worktrees[0]}/.git`, 'utf8')).toMatch(/^gitdir:/);
  expect(existsSync(`${a.nonGit}/.git`)).toBe(false);
  expect(execFileSync(a.env.APP_SHELL, ['-l', '-c', 'printf "%s" "$HOME"'], { env: a.env, encoding: 'utf8' })).toBe(process.env.HOME);
  const root = a.root;
  a.dispose();
  expect(existsSync(root)).toBe(false);
});
