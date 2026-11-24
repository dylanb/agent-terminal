import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANYWHERE, repairAdvice, within } from '../../src/main/fileRepairAdvice';

const denied = (): Error => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
const COMMAND = /```sh/;

let root: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-advice-')));
  file = join(root, 'charter.md');
  writeFileSync(file, 'charter\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ROOT_OWNED = '/etc/hosts';

it.each([
  ['the app runs as root on a path root owns', () => ({ target: ROOT_OWNED, operator: 0 })],
  ['another user owns the path', () => ({ target: file, operator: statSync(file).uid + 1 })],
])('offers no command when %s, and sends the operator to the owner or an administrator', (_case, setup) => {
  const { target, operator } = setup();
  expect(statSync(ROOT_OWNED).uid).toBe(0);
  const advice = repairAdvice(denied(), target, 'read', ANYWHERE, operator);
  expect.soft(advice).not.toMatch(COMMAND);
  expect.soft(advice).not.toMatch(/sudo/);
  expect.soft(advice).toContain(target);
  expect(advice).toMatch(/administrator/i);
});

it('offers the owner a command for the path', () => {
  const advice = repairAdvice(denied(), file, 'read', ANYWHERE, statSync(file).uid);
  expect(advice).toMatch(COMMAND);
});

it.each([
  ['the path lies outside the jail', () => { const jail = join(root, 'jail'); mkdirSync(jail); return within(jail); }],
  ['the jail cannot be resolved', () => within(null)],
])('gives manual instructions, never a command, when %s', (_case, scope) => {
  const advice = repairAdvice(denied(), file, 'read', scope(), statSync(file).uid);
  expect.soft(advice).not.toMatch(COMMAND);
  expect(advice).toContain(file);
});
