import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstallExamples, exampleInstallDirs } from '../../src/main/installExamples';
import { flowCatalogDir, loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { loadTodoTemplateFile, parseTodoTemplate } from '../../src/main/todoTemplate';

let root: string;
let operator: string;
let repo: string;
let flows: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'installed-finalize-'));
  repo = join(root, 'target-repository');
  flows = join(root, 'flows');
  mkdirSync(repo);
  const dirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, {
    flowGlobalDir: flows, configDir: join(root, 'config'), codexHome: join(root, '.codex'),
  });
  applyInstallExamples(dirs, []);
  const destination = dirs.find((dir) => dir.id === 'appLoops')?.targetDir;
  if (!destination) throw new Error('no installed loop destination');
  operator = destination;
});
afterAll(() => rmSync(root, { recursive: true }));

function finalize() {
  const flowDir = join(flowCatalogDir(flows), 'feature-dev-v3');
  const flow = loadUntrustedFlowDefinition(join(flowDir, 'flow.yaml'), null);
  if (!flow.ok) throw new Error(flow.error);
  const step = flow.definition.steps.find((s) => s.id === 'finalize');
  if (step?.kind !== 'loop' || !step.loop) throw new Error('finalize must be a loop');
  const resolved = resolveLoopDefV2(step.loop, {
    repoDir: repo, flow: 'feature-dev-v3', tiers: { operator, appBundled: join(root, 'absent-bundle'), retired: null },
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  return { def: resolved.def, step, flowDir };
}

describe('#251 installed finalization', () => {
  it('supplies a working goal, recipe and checklist', () => {
    const { def, step, flowDir } = finalize();
    expect(def.work.goal?.trim()).toBeTruthy();
    expect(readFileSync(def.work.recipe, 'utf8').trim()).toBeTruthy();
    const checklist = loadTodoTemplateFile(join(flowDir, 'todo-templates'), step.todoTemplate ?? '');
    expect(parseTodoTemplate(checklist ?? '').length).toBeGreaterThan(0);
  });
});
