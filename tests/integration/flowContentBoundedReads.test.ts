// Reads of flow content and of the app's own state in a working tree refuse a named pipe instead of reading
// it, so a pipe planted in repository content cannot freeze the main process, and refuse a file past its size
// limit instead of reading all of it.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitionFile, loadFlowDefinition, MAX_FLOW_DEFINITION_BYTES } from '../../src/main/flow';
import { MAX_LOOP_RECIPE_BYTES } from '../../src/main/loopDefV2';
import { createMonitorEventsFile, MAX_EVENTS_FILE_BYTES } from '../../src/main/monitorEventsFile';
import { assembleReportOnDisk, MAX_REPORT_SECTION_BYTES, sectionFile } from '../../src/main/reportSections';
import {
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_AGENT,
  installedCodexReviewerProblem,
  installedReviewerProblem,
  type InstalledReviewer,
} from '../../src/main/reviewerAgents';
import { createTodoStore, MAX_TODOS_FILE_BYTES } from '../../src/main/todoStore';
import { listTodoTemplates, MAX_TODO_TEMPLATE_BYTES, todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import type { MonitorEvent } from '../../src/shared/ipc';
import { createFedPipes } from '../helpers/fedPipe';

let root: string;
const pipes = createFedPipes();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-content-bounded-')));
});

afterEach(async () => {
  await pipes.reap();
  rmSync(root, { recursive: true, force: true });
});

const padding = (limit: number): string => ' '.repeat(limit + 1);

/** The one regular file a writer left under `dir`. */
function writtenFile(dir: string): string {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(dir, rel))
    .filter((f) => statSync(f).isFile());
  if (files.length !== 1) throw new Error(`expected one written file under ${dir}, found ${files.length}`);
  return files[0];
}

const validFlow = (name: string): string => yaml.dump({ name, steps: [{ id: 's1', kind: 'manual' }] });

describe('a flow definition', () => {
  it('is refused, not read, when it is a named pipe', () => {
    const repo = join(root, 'repo');
    pipes.at(flowDefinitionFile(repo), validFlow('piped'));
    const load = loadFlowDefinition(repo);
    expect(load.ok ? load.definition.name : load.error).toMatch(/^cannot read /);
  });

  it('is refused, not read, when it is larger than its limit', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(flowDefinitionFile(repo), '..'), { recursive: true });
    writeFileSync(flowDefinitionFile(repo), `${validFlow('big')}#${padding(MAX_FLOW_DEFINITION_BYTES)}\n`);
    const load = loadFlowDefinition(repo);
    expect(load.ok ? load.definition.name : load.error).toMatch(/larger than/);
  });

  it('is still read through a link at its own name', () => {
    const repo = join(root, 'repo');
    const kept = join(root, 'kept-elsewhere.yaml');
    writeFileSync(kept, validFlow('linked'));
    mkdirSync(join(flowDefinitionFile(repo), '..'), { recursive: true });
    symlinkSync(kept, flowDefinitionFile(repo));
    const load = loadFlowDefinition(repo);
    expect(load.ok ? load.definition.name : load.error).toBe('linked');
  });

  it('still reports a missing one as missing', () => {
    const load = loadFlowDefinition(join(root, 'repo'));
    expect(load.ok ? load.definition.name : load.error).toMatch(/^no flow\.yaml found at /);
  });
});

describe('the todo template picker', () => {
  it('names a piped template by its file name, not by a heading read from the pipe', () => {
    const dir = todoTemplatesDir(join(root, 'flow'));
    pipes.at(join(dir, todoTemplateFile('piped')), '# Fed Heading\n- a todo\n');
    const [entry] = listTodoTemplates(dir);
    expect(entry.ref).toBe('piped');
    expect(entry.name).not.toBe('Fed Heading');
  });

  it('names a template past its limit by its file name, not by its heading', () => {
    const dir = todoTemplatesDir(join(root, 'flow'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, todoTemplateFile('big')), `# Big Heading\n${padding(MAX_TODO_TEMPLATE_BYTES)}`);
    const [entry] = listTodoTemplates(dir);
    expect(entry.ref).toBe('big');
    expect(entry.name).not.toBe('Big Heading');
  });
});

describe('the repo todo list', () => {
  const storedTodosFile = (repo: string): string => {
    mkdirSync(repo, { recursive: true });
    createTodoStore({ maxDoneTodos: 10 }).add(repo, 'seed');
    return writtenFile(repo);
  };
  const todosJson = (text: string): string => JSON.stringify([{ id: 't1', repoKey: 'x', text, status: 'active', order: 1, createdAt: '2026-01-01T00:00:00.000Z' }]);

  it('is empty, not read, when its file is a named pipe', () => {
    const repo = join(root, 'repo');
    const file = storedTodosFile(repo);
    rmSync(file);
    pipes.at(file, todosJson('from the pipe'));
    expect(createTodoStore({ maxDoneTodos: 10 }).list(repo).map((t) => t.text)).toEqual([]);
  });

  it('is empty, not read, when its file is larger than its limit', () => {
    const repo = join(root, 'repo');
    const file = storedTodosFile(repo);
    writeFileSync(file, `${todosJson('too big')}${padding(MAX_TODOS_FILE_BYTES)}`);
    expect(createTodoStore({ maxDoneTodos: 10 }).list(repo).map((t) => t.text)).toEqual([]);
  });
});

describe('the persisted monitor events', () => {
  const event = (text: string): MonitorEvent => ({
    id: 'e1', sessionId: 's1', type: 'capture', source: 'selection', text, range: null, parentId: null, truncated: false,
    capturedAt: '2026-06-12T10:00:00.000Z',
  });
  const savedEventsFile = (launchRoot: string): string => {
    mkdirSync(launchRoot, { recursive: true });
    createMonitorEventsFile(launchRoot).save([event('seed')]);
    return writtenFile(launchRoot);
  };

  it('load nothing, not the pipe, when the events file is a named pipe', () => {
    const launchRoot = join(root, 'launch');
    const file = savedEventsFile(launchRoot);
    rmSync(file);
    pipes.at(file, JSON.stringify([event('from the pipe')]));
    expect(createMonitorEventsFile(launchRoot).load()).toEqual([]);
  });

  it('load nothing when the events file is larger than its limit', () => {
    const launchRoot = join(root, 'launch');
    const file = savedEventsFile(launchRoot);
    writeFileSync(file, `${JSON.stringify([event('too big')])}${padding(MAX_EVENTS_FILE_BYTES)}`);
    expect(createMonitorEventsFile(launchRoot).load()).toEqual([]);
  });
});

describe('assembling a sectioned report', () => {
  const ORDER = ['infra', 'green'];
  const report = () => ({ path: join(root, 'impl-report.md'), sectionsDir: { path: join(root, 'impl-report'), rel: 'impl-report' } });
  const sectionPath = (step: string): string => sectionFile(report().sectionsDir, step, 1)!.path;
  const writeSection = (step: string, body: string): void => {
    mkdirSync(report().sectionsDir.path, { recursive: true });
    writeFileSync(sectionPath(step), body);
  };

  it('refuses a section file that is a named pipe', () => {
    writeSection('infra', '## infra\n');
    pipes.at(sectionPath('green'), '## green\nfrom the pipe\n');
    expect(() => assembleReportOnDisk(report(), ORDER)).toThrow(/impl-report/);
  });

  it('refuses a section file larger than its limit', () => {
    writeSection('infra', `## infra\n${padding(MAX_REPORT_SECTION_BYTES)}`);
    expect(() => assembleReportOnDisk(report(), ORDER)).toThrow(/larger than/);
  });

  it('refuses an existing report that is a named pipe', () => {
    writeSection('infra', '## infra\n');
    pipes.at(report().path, '## hand-written\nfrom the pipe\n');
    expect(() => assembleReportOnDisk(report(), ORDER)).toThrow(/impl-report\.md/);
  });

  it('refuses an existing report larger than its limit', () => {
    writeSection('infra', '## infra\n');
    writeFileSync(report().path, `## hand-written\n${padding(MAX_REPORT_SECTION_BYTES)}`);
    expect(() => assembleReportOnDisk(report(), ORDER)).toThrow(/larger than/);
  });
});

describe('checking an installed reviewer against the charter the run resolved', () => {
  const formats = [
    { label: 'Claude Code', format: CLAUDE_REVIEWER_AGENT, problem: installedReviewerProblem },
    { label: 'Codex', format: CODEX_REVIEWER_AGENT, problem: installedCodexReviewerProblem },
  ] as const;

  const installedWith = (format: (typeof formats)[number]['format'], charterText: string): { agentsDir: string; reviewer: InstalledReviewer } => {
    const agentsDir = join(root, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const reviewer: InstalledReviewer = { loop: 'probe-loop', persona: 'probe', charter: join(root, 'charters', 'probe.md'), tools: 'all' };
    writeFileSync(join(agentsDir, `${format.name(reviewer.loop, reviewer.persona)}${format.extension}`), format.render({ ...reviewer, charter: charterText }));
    mkdirSync(join(root, 'charters'), { recursive: true });
    return { agentsDir, reviewer };
  };

  for (const { label, format, problem } of formats) {
    it(`reports a problem, never a pass, when the charter is a named pipe (${label})`, () => {
      const charterText = 'Review the piped charter.\n';
      const { agentsDir, reviewer } = installedWith(format, charterText);
      pipes.at(reviewer.charter, charterText);
      expect(problem(agentsDir, reviewer) ?? 'passed').toContain(reviewer.charter);
    });

    it(`reports a problem, never a pass, when the charter is larger than its limit (${label})`, () => {
      const charterText = `Review the big charter.\n${padding(MAX_LOOP_RECIPE_BYTES)}`;
      const { agentsDir, reviewer } = installedWith(format, charterText);
      writeFileSync(reviewer.charter, charterText);
      expect(problem(agentsDir, reviewer) ?? 'passed').toMatch(/larger than/);
    });
  }
});
