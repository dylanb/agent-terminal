import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { createFlowStateStore } from '../../src/main/flowState';
import { seedAuditPublicationGh } from '../helpers/auditPublicationGh';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { useInstalledRuntime, type RunOptions } from './installedRuntime';

const runtime = useInstalledRuntime();
let repo: string;
let git: GitRepoFixture;

test.beforeEach(() => {
  git = createGitRepoFixture();
  repo = realpathSync(git.makeGitRepo('finalize target'));
  git.git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/project.git']);
});

test.afterEach(() => {
  git?.cleanup();
});

const invoke = (args: string[], env: RunOptions['env'] = {}) => runtime.runRaw(args, { cwd: repo, env });

/** A PATH whose first entry is `bin`, with this test run's own `node` in it for the `gh` stand-ins' shebang. */
function pathWith(bin: string): string {
  symlinkSync(process.execPath, join(bin, 'node'));
  return `${bin}:/usr/bin:/bin`;
}

function response(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return { invalidJsonResponse: stdout }; }
}

test('#251 installed evidence access reads the current recorder-created run without the source checkout', async () => {
  const { home } = runtime.world();
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

  const result = await invoke(['audit-evidence', repo], { APP_HOME_DIR: undefined });
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

test('#251 installed evidence access follows the app home when it differs from the shell home', async () => {
  const { appHome } = runtime.world();
  const flow = 'feature-dev-v3';
  const startedAt = Date.parse('2026-10-24T10:00:00.684Z');
  createFlowStateStore(repo).write({ step: 'finalize', status: 'in_progress', flow, startedAt });
  const recorder = createAuditRecorder({ root: auditRootDir(appHome), now: () => new Date(startedAt), flowName: () => flow });
  recorder.recordTransition(repo, 'start', { status: 'not_started', stepName: 'finalize' }, { status: 'in_progress', stepName: 'finalize' }, { flow, startedAt });

  const result = await invoke(['audit-evidence', repo]);

  expect(result.status).toBe(0);
  expect(response(result.stdout)).toMatchObject({
    coverage: 'complete',
    visits: [{ step: 'finalize', exited: null, elapsedMs: null }],
  });
});

test('#251 installed work-time publication reads the actual artifact and appends it to the associated PR', async () => {
  const world = runtime.world();
  const bin = world.dir('bin');
  const stateFile = join(world.root, 'github.json');
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

  const result = await invoke(['publish-flow-audit', repo, '41', artifact], { PATH: pathWith(bin), FINALIZE_GH_STATE: stateFile });
  const published = JSON.parse(readFileSync(stateFile, 'utf8'));
  test.info().attach('runtime-stderr', { body: result.stderr, contentType: 'text/plain' });
  expect.soft(result.status).toBe(0);
  expect.soft(response(result.stdout)).toEqual({ outcome: 'done' });
  expect.soft(published.body).toBe(`${original}\n<!-- agent-terminal:flow-audit:start -->\n${readFileSync(artifact, 'utf8')}<!-- agent-terminal:flow-audit:end -->\n`);
  expect(published.writes).toEqual([{
    repository: 'github.com/fixture/project', pr: 41, body: published.body,
  }]);
});

function publication(body: string) {
  const bin = runtime.world().dir('publication-bin');
  const gh = seedAuditPublicationGh(bin, body);
  const artifact = join(repo, '.agent-terminal', 'loop', 'artifacts', 'flow-audit.md');
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'Current report\n');
  return { gh, artifact, run: () => invoke(['publish-flow-audit', repo, '41', artifact], { PATH: pathWith(bin) }) };
}

test('#251 installed publication cannot claim success for mismatching remote readback', async () => {
  const fx = publication('Operator context\n');
  fx.gh.set({ discard: true });
  const result = await fx.run();
  expect.soft(result.status).not.toBe(0);
  expect.soft(response(result.stdout)).not.toEqual({ outcome: 'done' });
  expect(fx.gh.read().writes).toHaveLength(1);
});

test('#251 installed evidence access marks missing, unreadable and mismatched history unavailable', async () => {
  const { appHome: home } = runtime.world();
  const flow = 'feature-dev-v3';
  const started = new Date('2026-10-24T10:00:00Z');
  createFlowStateStore(repo).write({ step: 'finalize', status: 'in_progress', flow, startedAt: started.getTime() });
  const file = auditFilePath(auditRootDir(home), repo, flow, started);
  const unavailable = async () => {
    const result = await invoke(['audit-evidence', repo]);
    expect(result.status).toBe(0);
    expect(response(result.stdout)).toMatchObject({ coverage: 'unavailable', header: null, events: [] });
  };
  await unavailable();
  mkdirSync(file, { recursive: true });
  await unavailable();
  rmSync(file, { recursive: true });
  const recorder = createAuditRecorder({ root: auditRootDir(home), now: () => started, flowName: () => flow });
  recorder.recordTransition(repo, 'start', { status: 'not_started', stepName: 'finalize' }, { status: 'in_progress', stepName: 'finalize' }, { flow, startedAt: started.getTime() });
  const recorded = readFileSync(file, 'utf8');
  writeFileSync(file, recorded.replace('feature-dev-v3', 'another-flow'));
  await unavailable();
});
