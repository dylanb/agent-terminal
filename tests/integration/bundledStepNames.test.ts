import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstallExamples, exampleInstallDirs } from '../../src/main/installExamples';
import { catalogEntryDefFile, loadUntrustedFlowDefinition, type FlowStepDef } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { STEP_DEF_EXT, createStepLibrary } from '../../src/main/stepLibrary';

const loc = { packaged: false as const, appPath: process.cwd() };
const OPERATOR_STEP_NAMES = ['preparation', 'plan-approve', 'impl-approve', 'finalize'];

describe('an operator’s own step definitions do not replace an installed bundled flow’s steps (§18.2)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bundled-step-names-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const install = (name: string, ownSteps: string[]): ((flow: string) => FlowStepDef[]) => {
    const flowGlobalDir = join(root, name, 'home');
    const dirs = exampleInstallDirs(loc, { flowGlobalDir, configDir: join(root, name, 'config'), codexHome: join(root, name, '.codex') });
    const stepsDir = dirs.find((d) => d.id === 'stepLibrary')?.targetDir;
    if (stepsDir === undefined || stepsDir === null) throw new Error('no step library destination');
    mkdirSync(stepsDir, { recursive: true });
    for (const step of ownSteps) writeFileSync(join(stepsDir, `${step}${STEP_DEF_EXT}`), 'kind: loop\nloop: operator-own-loop\nloop_namespace: app\n');
    const result = applyInstallExamples(dirs, []);
    if (!result.ok) throw new Error(result.error);
    const library = createStepLibrary([{ name: 'global', dir: stepsDir }]);
    return (flow) => {
      const load = loadUntrustedFlowDefinition(catalogEntryDefFile(flowGlobalDir, flow), library);
      if (!load.ok) throw new Error(`${flow}: ${load.error}`);
      return load.definition.steps;
    };
  };

  it('every installed bundled flow loads the same steps when the operator keeps step files of their own', () => {
    const flows = readdirSync(resolveExampleFlowsDir(loc), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(flows.length).toBeGreaterThan(0);
    const clean = install('clean', []);
    const operator = install('operator', OPERATOR_STEP_NAMES);
    for (const flow of flows) expect(operator(flow), flow).toEqual(clean(flow));
  });
});
