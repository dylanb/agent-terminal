import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveArtifactCheckScript } from '../../src/main/artifactCheck';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditRootDir } from '../../src/main/auditPaths';
import { createFlowStateStore } from '../../src/main/flowState';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';

const requirePackage = createRequire(__filename);
let root: string;
let repo: string;
let home: string;
let runtimeMain: string;
let git: GitRepoFixture;

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installed-finalize-'));
  home = join(root, 'home');
  mkdirSync(home);
  runtimeMain = join(root, 'installed-app', 'out', 'main');
  cpSync(resolve('out/main'), runtimeMain, { recursive: true });
  cpSync(dirname(requirePackage.resolve('js-yaml/package.json')), join(root, 'installed-app', 'node_modules', 'js-yaml'), { recursive: true });
  git = createGitRepoFixture();
  repo = realpathSync(git.makeGitRepo('finalize target'));
  git.git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/project.git']);
});

test.afterEach(() => {
  git?.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function invoke(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(requirePackage('electron') as string, [resolveArtifactCheckScript(runtimeMain), ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1', ...environment },
    encoding: 'utf8', timeout: 15_000,
  });
}

function response(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return { invalidJsonResponse: stdout }; }
}

test('#251 installed evidence access reads the current recorder-created run without the source checkout', () => {
  const flow = 'feature-dev-v3';
  const startedAt = Date.parse('2026-10-24T10:00:00Z');
  let time = startedAt;
  createFlowStateStore(repo).write({ step: 'finalize', status: 'in_progress', flow, startedAt, inputs: { ticket: '251' } });
  const recorder = createAuditRecorder({ root: auditRootDir(home), now: () => new Date(time), flowName: () => flow });
  recorder.recordTransition(repo, 'start', { status: 'not_started', stepName: 'plan' }, { status: 'in_progress', stepName: 'plan' }, { flow, startedAt });
  time += 60_000;
  recorder.recordTodoChange(repo, [], [{ id: 'a', text: 'Resolve approved intent', status: 'active' }]);
  time += 60_000;
  recorder.recordTodoChange(repo, [{ id: 'a', text: 'Resolve approved intent', status: 'active' }], [{ id: 'a', text: 'Resolve approved intent', status: 'done' }]);
  time += 60_000;
  recorder.recordTransition(repo, 'advance', { status: 'in_progress', stepName: 'plan' }, { status: 'in_progress', stepName: 'finalize' });

  const result = invoke(['audit-evidence', repo]);
  expect.soft(result.error).toBeUndefined();
  test.info().attach('runtime-stderr', { body: result.stderr, contentType: 'text/plain' });
  expect.soft(result.status).toBe(0);
  expect(response(result.stdout)).toMatchObject({
    coverage: 'complete',
    header: { flow, repoPath: repo, started: '2026-10-24T10:00:00Z' },
    visits: [
      { step: 'plan', completedTodoCount: 1, elapsedMs: 180_000 },
      { step: 'finalize', exited: null, elapsedMs: null },
    ],
  });
});

test('#251 installed work-time publication reads the actual artifact and appends it to the associated PR', () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stateFile = join(root, 'github.json');
  const original = '# Implementation\n\nKeep operator context.\n\nCloses #251\n';
  const report = '# Flow audit\n\nDevelopment complete; human completion and merge remain.\n';
  writeFileSync(stateFile, JSON.stringify({ body: original, writes: [] }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FINALIZE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const option = name => args[args.indexOf(name) + 1];
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'fixture/project', url: 'https://github.com/fixture/project', defaultBranchRef: { name: 'main' } }));
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ number: 41, body: state.body, state: 'OPEN', headRefName: 'feature-251' }));
} else if (args[0] === 'pr' && args[1] === 'edit') {
  const bodyFile = option('--body-file');
  state.body = fs.readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8');
  state.writes.push({ repository: option('--repo'), pr: Number(args[2]), body: state.body });
  fs.writeFileSync(file, JSON.stringify(state));
} else {
  process.stderr.write('Unexpected GitHub operation: ' + JSON.stringify(args));
  process.exitCode = 97;
}
`, { mode: 0o755 });
  const artifact = join(repo, '.agent-terminal', 'loop', 'artifacts', 'flow-audit.md');
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, report);

  const result = invoke(['publish-flow-audit', repo, '41', artifact], { PATH: `${bin}:${process.env.PATH}`, FINALIZE_GH_STATE: stateFile });
  const published = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect.soft(result.error).toBeUndefined();
  test.info().attach('runtime-stderr', { body: result.stderr, contentType: 'text/plain' });
  expect.soft(result.status).toBe(0);
  expect.soft(response(result.stdout)).toEqual({ outcome: 'done' });
  expect.soft(published.body).toBe(`${original}\n<!-- agent-terminal:flow-audit:start -->\n${readFileSync(artifact, 'utf8')}<!-- agent-terminal:flow-audit:end -->\n`);
  expect(published.writes).toEqual([{
    repository: 'github.com/fixture/project', pr: 41, body: published.body,
  }]);
});
