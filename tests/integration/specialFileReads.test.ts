// A run's own reads of a loop definition, the repository's loop override registry and a todo template refuse a
// named pipe instead of reading it, so a pipe planted in repository content cannot freeze the main process, and
// refuse a file past its size limit instead of reading all of it.

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOOP_OVERRIDE_FILE, LOOP_OVERRIDE_MAP_KEY, loopDefRelPath } from '../../src/main/appLoopPaths';
import { MAX_LOOP_DEF_BYTES, MAX_LOOP_REGISTRY_BYTES, resolveLoopDefV2, type LoopDefV2Context } from '../../src/main/loopDefV2';
import { loadTodoTemplateFile, MAX_TODO_TEMPLATE_BYTES, todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { LOOP_DEF_V2_VERSION } from '../../src/shared/engineCapabilities/loop';
import { writeLoopDef } from '../helpers/flowFixtures';
import { createFedPipes } from '../helpers/fedPipe';

let root: string;
const pipes = createFedPipes();
const fedPipe = (file: string, content: string): void => pipes.at(file, content);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'special-file-reads-')));
});

afterEach(async () => {
  await pipes.reap();
  rmSync(root, { recursive: true, force: true });
});

const context = (operator: string, repoDir: string): LoopDefV2Context => ({
  tiers: { operator, appBundled: join(root, 'empty-bundle'), retired: null },
  repoDir,
});

const validDef = (): string => yaml.dump({
  version: LOOP_DEF_V2_VERSION,
  work: { recipe: 'recipe.md', artifact: 'result' },
  reviewers: [],
  boundaries: [],
  report: { sections: [] },
  gate: [],
});

describe('a run never reads a named pipe as its input', () => {
  it('refuses a loop definition that is a named pipe, naming that definition', () => {
    const operator = join(root, 'operator-loops');
    const defFile = join(operator, loopDefRelPath('pipe-loop'));
    writeLoopDef(operator, 'pipe-loop');
    rmSync(defFile);
    fedPipe(defFile, validDef());
    const result = resolveLoopDefV2('pipe-loop', context(operator, join(root, 'repo')));
    expect({ ok: result.ok, defFile: result.defFile }).toEqual({ ok: false, defFile });
  });

  it('refuses a repository loop override registry that is a named pipe', () => {
    const repo = join(root, 'repo');
    const defFile = writeLoopDef(join(repo, 'own-loops'), 'mapped-loop');
    fedPipe(join(repo, LOOP_OVERRIDE_FILE), yaml.dump({ [LOOP_OVERRIDE_MAP_KEY]: { 'mapped-loop': relative(repo, defFile) } }));
    const result = resolveLoopDefV2('mapped-loop', context(join(root, 'operator-loops'), repo));
    expect(result.ok).toBe(false);
  });

  it('does not resolve a todo template that is a named pipe', () => {
    const flowDir = join(root, 'flow');
    fedPipe(join(todoTemplatesDir(flowDir), todoTemplateFile('piped')), '- a todo\n');
    expect(loadTodoTemplateFile(todoTemplatesDir(flowDir), 'piped')).toBeNull();
  });
});

/** A YAML or Markdown comment line that takes a file past `limit` bytes on its own. */
const pastLimit = (limit: number): string => `\n# ${'x'.repeat(limit)}\n`;

const registryMapping = (repo: string, loop: string): string => {
  const defFile = writeLoopDef(join(repo, 'own-loops'), loop);
  return yaml.dump({ [LOOP_OVERRIDE_MAP_KEY]: { [loop]: relative(repo, defFile) } });
};

describe('a run never reads an input past its size limit', () => {
  it('refuses a loop definition larger than its limit, naming that definition', () => {
    const operator = join(root, 'operator-loops');
    const defFile = writeLoopDef(operator, 'big-loop');
    appendFileSync(defFile, pastLimit(MAX_LOOP_DEF_BYTES));
    const result = resolveLoopDefV2('big-loop', context(operator, join(root, 'repo')));
    expect({ ok: result.ok, defFile: result.defFile }).toEqual({ ok: false, defFile: realpathSync(defFile) });
  });

  it('refuses a repository loop override registry larger than its limit', () => {
    const repo = join(root, 'repo');
    writeFileSync(join(repo, LOOP_OVERRIDE_FILE), registryMapping(repo, 'mapped-loop') + pastLimit(MAX_LOOP_REGISTRY_BYTES));
    const result = resolveLoopDefV2('mapped-loop', context(join(root, 'operator-loops'), repo));
    expect(result.ok).toBe(false);
  });

  it('does not resolve a todo template larger than its limit', () => {
    const dir = todoTemplatesDir(join(root, 'flow'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, todoTemplateFile('big')), `- a todo${pastLimit(MAX_TODO_TEMPLATE_BYTES)}`);
    expect(loadTodoTemplateFile(dir, 'big')).toBeNull();
  });
});

describe('a run still follows a repository loop override registry that is a link', () => {
  it('resolves a loop through a registry that links to a regular file', () => {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked-registry.yaml');
    writeFileSync(linked, registryMapping(repo, 'mapped-loop'));
    symlinkSync(linked, join(repo, LOOP_OVERRIDE_FILE));
    const result = resolveLoopDefV2('mapped-loop', context(join(root, 'operator-loops'), repo));
    expect({ ok: result.ok, defFile: result.defFile }).toEqual({ ok: true, defFile: realpathSync(join(repo, 'own-loops', loopDefRelPath('mapped-loop'))) });
  });
});

