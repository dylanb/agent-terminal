import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import yaml from 'js-yaml';
import * as fs from 'node:fs';
import { runInstallReviewers, type InstallReviewersDeps } from '../../src/main/installReviewers';
import { codexReviewerAgentName, installedCodexReviewerProblem, installedReviewerProblem, reviewerAgentName, type InstalledReviewer } from '../../src/main/reviewerAgents';
import { userConfigAgentsDir } from '../../src/main/userConfig';
import { codexAgentsDir } from '../../src/main/codexConfig';
import { flowLocations, writeFlow, writeLoopDef, writeLoopRegistry } from '../helpers/flowFixtures';
import { ageInstalledReviewers, completedReviewerWrites, installedReviewerSnapshot } from '../helpers/reviewerInstallFiles';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string;
let folder: string;
let definition: string;
let deps: InstallReviewersDeps;
let output: string;
const charter = 'Evaluate the selected cedar contract.\n';
const loop = 'quality-loop';
const spec = (): InstalledReviewer => ({ flow: 'cedar', loop, persona: 'reviewer-1', charter: join(dirname(definition), 'review.md'), tools: 'all' });
const agentDirs = (): string[] => [userConfigAgentsDir(deps.configDir)!, codexAgentsDir(deps.codexHome!)];
const files = (): string[] => agentDirs().flatMap((dir) => existsSync(dir) ? readdirSync(dir).map((file) => join(dir, file)) : []);
function tree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => { const file = join(entry.parentPath, entry.name); return [relative(dir, file), readFileSync(file).toString('base64')]; }));
}
function availability(reviewer = spec()): (string | null)[] {
  return [installedReviewerProblem(agentDirs()[0], reviewer), installedCodexReviewerProblem(agentDirs()[1], reviewer)];
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-guarantees-')));
  const appHome = join(root, 'app');
  folder = flowLocations.globalCatalogEntry(appHome, 'catalog-id');
  writeFlow(folder, { name: 'cedar', steps: [{ id: 'quality', kind: 'loop', loop }] });
  const operator = join(root, 'loops');
  definition = writeLoopDef(operator, loop, { charters: ['review.md'], consolidator: 'judge.md' }, { flow: 'cedar' });
  writeFileSync(join(dirname(definition), 'review.md'), charter);
  const codexHome = join(root, 'codex');
  mkdirSync(codexHome);
  output = '';
  deps = { cwd: () => root, appHome, configDir: join(root, 'claude'), codexHome,
    loopTiers: { operator, appBundled: join(root, 'bundle'), retired: null },
    write: (text) => { output += text; }, confirm: async () => true };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('global selection ignores the invoking repository override and preserves sources and unrelated assets', async () => {
  const repo = join(root, 'repo');
  const override = writeLoopDef(join(repo, 'overrides'), loop, { charters: ['review.md'], consolidator: 'judge.md' });
  writeFileSync(join(dirname(override), 'review.md'), 'WRONG repository charter');
  writeLoopRegistry(repo, { [loop]: relative(repo, override) });
  deps.cwd = () => repo;
  const unrelated = join(deps.configDir!, 'commands', 'keep.md');
  mkdirSync(dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, 'keep');
  const unselected = flowLocations.globalCatalogEntry(deps.appHome, 'unselected');
  writeFlow(unselected, { name: 'unselected', steps: [{ id: 'quality', kind: 'loop', loop }] });
  writeLoopDef(deps.loopTiers.operator!, loop, { charters: ['review.md'], consolidator: 'judge.md' }, { flow: 'unselected' });
  const before = tree(root);
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  expect.soft(availability()).toEqual([null, null]);
  const after = tree(root);
  delete after[relative(root, join(agentDirs()[0], `${reviewerAgentName(loop, 'reviewer-1', 'cedar')}.md`))];
  delete after[relative(root, join(agentDirs()[1], `${codexReviewerAgentName(loop, 'reviewer-1', 'cedar')}.toml`))];
  expect.soft(after).toEqual(before);
  expect(readFileSync(unrelated, 'utf8')).toBe('keep');
});

it('different flow names coexist while switching same-name sources requires independent replacement consent', async () => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  const original = files();
  ageInstalledReviewers(original);
  const before = installedReviewerSnapshot(original);
  const other = flowLocations.repoCatalogEntry(join(root, 'repo'), 'other');
  writeFlow(other, { name: 'birch', steps: [{ id: 'quality', kind: 'loop', loop }] });
  const birch = writeLoopDef(deps.loopTiers.operator!, loop, { charters: ['review.md'], consolidator: 'judge.md' }, { flow: 'birch' });
  writeFileSync(join(dirname(birch), 'review.md'), 'Different birch contract');
  expect(await runInstallReviewers([other], deps)).toBe(0);
  expect.soft(installedReviewerSnapshot(original)).toEqual(before);
  expect.soft(availability({ ...spec(), flow: 'birch', charter: join(dirname(birch), 'review.md') })).toEqual([null, null]);
  const birchFiles = files().filter((file) => !original.includes(file));
  const birchBefore = installedReviewerSnapshot(birchFiles);
  writeFlow(other, { name: 'cedar', steps: [{ id: 'quality', kind: 'loop', loop }] });
  const replacement = writeLoopDef(join(root, 'repo', 'own'), loop, { charters: ['review.md'], consolidator: 'judge.md' });
  writeFileSync(join(dirname(replacement), 'review.md'), 'Replacement cedar contract');
  writeLoopRegistry(join(root, 'repo'), { [loop]: relative(join(root, 'repo'), replacement) });
  const selected = { ...spec(), charter: join(dirname(replacement), 'review.md') };
  deps.confirm = async (question) => !question.startsWith('Replace');
  output = '';
  expect(await runInstallReviewers([other], deps)).toBe(0);
  expect.soft(installedReviewerSnapshot(original)).toEqual(before);
  expect.soft(availability(selected).every((problem) => problem !== null)).toBe(true);
  expect.soft(output).toMatch(/declined.*unavailable/i);
  deps.confirm = async (question) => !question.startsWith('Replace') || question.includes('codexAgents');
  expect(await runInstallReviewers([other], deps)).toBe(0);
  expect.soft(availability(selected)[0]).not.toBeNull();
  expect.soft(availability(selected)[1]).toBeNull();
  deps.confirm = async () => true;
  expect(await runInstallReviewers([other], deps)).toBe(0);
  expect.soft(availability(selected)).toEqual([null, null]);
  expect(installedReviewerSnapshot(birchFiles)).toEqual(birchBefore);
});

it('honors Claude-only consent while Codex remains mismatched and unchanged', async () => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  const installed = files();
  for (const file of installed) writeFileSync(file, 'Operator-edited reviewer');
  ageInstalledReviewers(installed);
  const declined = installed.filter((file) => file.startsWith(agentDirs()[1]));
  const before = installedReviewerSnapshot(declined);
  deps.confirm = async (question) => !question.startsWith('Replace') || question.includes('in agents');
  expect.soft(await runInstallReviewers([folder], deps)).toBe(0);
  expect.soft(availability()[0]).toBeNull();
  expect.soft(availability()[1]).not.toBeNull();
  expect(installedReviewerSnapshot(declined)).toEqual(before);
});

it.each(['source', 'target'] as const)('refuses stale %s consent without applying any other file', async (changed) => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  const installed = files();
  for (const file of installed) writeFileSync(file, 'Operator edit');
  let atConfirmation: Record<string, string> = {};
  deps.confirm = async (question) => {
    if (question.startsWith('Install')) {
      writeFileSync(changed === 'source' ? spec().charter : installed[0], 'Changed since preview');
      atConfirmation = tree(root);
    }
    return true;
  };
  output = '';
  expect.soft(await runInstallReviewers([folder], deps)).toBe(1);
  expect.soft(tree(root)).toEqual(atConfirmation);
  expect(output).toMatch(/changed|preview again/i);
});

it('cancelling after accepting replacements preserves all edited targets and source files', async () => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  for (const file of files()) writeFileSync(file, 'Operator edit');
  const before = tree(root);
  deps.confirm = async (question) => question.startsWith('Replace');
  output = '';
  expect.soft(await runInstallReviewers([folder], deps)).toBe(3);
  expect.soft(tree(root)).toEqual(before);
  expect(output).toMatch(/unavailable/i);
});

it('repeat installation preserves bytes and old mtimes and asks no consent', async () => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  const installed = files();
  ageInstalledReviewers(installed);
  const before = installedReviewerSnapshot(installed);
  const questions: string[] = [];
  deps.confirm = async (question) => { questions.push(question); return false; };
  output = '';
  expect.soft(await runInstallReviewers([folder], deps)).toBe(0);
  expect.soft(installedReviewerSnapshot(installed)).toEqual(before);
  expect.soft(questions).toEqual([]);
  for (const file of installed) expect.soft(output).toContain(`unchanged: ${file.includes('codex') ? 'codexAgents' : 'agents'}/${file.split('/').at(-1)}`);
});

it('a reviewer-free flow is a no-op even with installed legacy agents', async () => {
  writeFlow(folder, { name: 'cedar', steps: [{ id: 'manual', kind: 'manual' }] });
  const legacy = join(agentDirs()[0], 'plan-bundle-loop--review-plan-intent.md');
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, 'Legacy agent');
  const before = tree(root);
  deps.confirm = async () => { throw new Error('No-op requested consent'); };
  expect.soft(await runInstallReviewers([folder], deps)).toBe(0);
  expect.soft(tree(root)).toEqual(before);
  expect(output).toMatch(/nothing.*install/i);
});

it('absent Codex is unavailable and never provisioned while Claude installs', async () => {
  const absent = deps.codexHome!;
  rmSync(absent, { recursive: true });
  expect.soft(await runInstallReviewers([folder], deps)).toBe(0);
  expect.soft(installedReviewerProblem(userConfigAgentsDir(deps.configDir), spec())).toBeNull();
  expect.soft(existsSync(absent)).toBe(false);
  expect(output).toMatch(/skipped.*unavailable.*codex/i);
});

it.each(['flow', 'loop', 'missing charter', 'directory charter', 'unsupported charter', 'tools', 'destination'] as const)('preflights invalid %s before creating any reviewer', async (invalid) => {
  if (invalid === 'flow') writeFileSync(join(folder, 'flow.yaml'), 'steps: [');
  if (invalid === 'loop') rmSync(definition);
  if (invalid === 'missing charter' || invalid === 'directory charter') {
    rmSync(spec().charter);
    if (invalid === 'directory charter') mkdirSync(spec().charter);
  }
  if (invalid === 'unsupported charter') writeFileSync(spec().charter, String.fromCharCode(39).repeat(3));
  if (invalid === 'tools') {
    const doc = yaml.load(readFileSync(definition, 'utf8')) as { reviewers: { tools?: string[] }[] };
    doc.reviewers[0].tools = ['Write'];
    writeFileSync(definition, yaml.dump(doc));
  }
  if (invalid === 'destination') writeFileSync(agentDirs()[1], 'not a directory');
  const before = tree(root);
  expect.soft(await runInstallReviewers([folder], deps)).toBe(1);
  expect.soft(tree(root)).toEqual(before);
  expect.soft(existsSync(agentDirs()[0])).toBe(false);
  const diagnostic = {
    flow: { source: join(folder, 'flow.yaml'), cause: /yaml|parse|end of the stream/i },
    loop: { source: loop, cause: /resolve|not found|missing|cannot find|no.*def.*any tier/i },
    'missing charter': { source: 'review.md', cause: /not.*readable|does not exist|cannot read|missing/i },
    'directory charter': { source: 'review.md', cause: /not.*readable|regular file|directory/i },
    'unsupported charter': { source: 'reviewer-1', cause: /TOML literal/i },
    tools: { source: 'reviewer-1', cause: /Write.*read-only Codex/i },
    destination: { source: agentDirs()[1], cause: /directory.*readable.*traversable|not a directory/i },
  }[invalid];
  expect.soft(output).toContain(diagnostic.source);
  expect(output).toMatch(diagnostic.cause);
});


it.each(['accept', 'decline', 'cancel'] as const)('a partial-write failure supports %s retry with fresh consent and preserved successes', async (choice) => {
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  const installed = files();
  for (const file of installed) rmSync(file);
  const rename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  let writes = 0;
  const fault = vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (installed.includes(String(to)) && ++writes === 2) throw Object.assign(new Error('fixture destination write failed'), { code: 'EIO' });
    rename(from, to);
  });
  output = '';
  const failed = await runInstallReviewers([folder], deps);
  fault.mockImplementation(rename);
  const completed = installed.find(existsSync)!;
  const outstanding = installed.find((file) => !existsSync(file))!;
  const completedGroup = completed.startsWith(agentDirs()[0]) ? 'agents' : 'codexAgents';
  const outstandingGroup = outstanding.startsWith(agentDirs()[0]) ? 'agents' : 'codexAgents';
  const platform = outstandingGroup === 'agents' ? '(?:Claude(?: Code)?|agents)' : '(?:Codex|codexAgents)';
  const unavailableEntry = new RegExp(String.raw`(?:unavailable\)?:[ \t]*${platform}\b|\b${platform}(?: reviewers)?(?: are| is| remain|:)? unavailable\b)`, 'i');
  expect.soft(failed).toBe(1);
  expect.soft(existsSync(completed)).toBe(true);
  expect.soft(existsSync(outstanding)).toBe(false);
  expect.soft(completedReviewerWrites(output)).toEqual([`created: ${completedGroup}/${completed.split('/').at(-1)}`]);
  expect.soft(output).toContain(outstanding.split('/').at(-1)!);
  expect.soft(output).toMatch(/incomplete|unavailable/i);
  ageInstalledReviewers([completed]);
  const preserved = installedReviewerSnapshot([completed]);
  writeFileSync(outstanding, 'New operator edit after failure');
  const beforeRetry = installedReviewerSnapshot(installed);
  const questions: string[] = [];
  let completionStart = 0;
  deps.confirm = async (question) => {
    questions.push(question);
    if (!question.startsWith('Replace')) completionStart = output.length;
    return question.startsWith('Replace') ? choice === 'accept' : choice !== 'cancel';
  };
  output = '';
  expect.soft(await runInstallReviewers([folder], deps)).toBe(choice === 'cancel' ? 3 : 0);
  expect.soft(installedReviewerSnapshot([completed])).toEqual(preserved);
  expect.soft(questions.some((question) => question.startsWith('Replace') && question.includes(outstandingGroup))).toBe(true);
  expect.soft(questions.some((question) => question.startsWith('Replace') && question.includes(`in ${completedGroup}`))).toBe(false);
  if (choice === 'accept') {
    expect.soft(availability()).toEqual([null, null]);
    expect.soft(output).toContain(`replaced: ${outstandingGroup}/`);
  } else {
    expect.soft(installedReviewerSnapshot(installed)).toEqual(beforeRetry);
    expect.soft(availability()[outstandingGroup === 'agents' ? 0 : 1]).not.toBeNull();
    const completion = output.slice(completionStart);
    expect.soft(completion).toMatch(unavailableEntry);
  }
});

it('cancelled retry identifies the absent platform as unavailable without provisioning it', async () => {
  const absent = deps.codexHome!;
  rmSync(absent, { recursive: true });
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  for (const file of files()) writeFileSync(file, 'Operator edit');
  const before = tree(root);
  deps.confirm = async () => false;
  output = '';
  expect.soft(await runInstallReviewers([folder], deps)).toBe(3);
  expect.soft(tree(root)).toEqual(before);
  expect.soft(existsSync(absent)).toBe(false);
  expect.soft(output).toMatch(/unavailable: agents\//i);
  expect(output).toMatch(/skipped.*unavailable.*codex/i);
});
