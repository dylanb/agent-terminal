import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOW_DEF_FILE, flowCatalogDir, flowDefinitionFile, type FlowStepDef } from '../../src/main/flow';
import { recordDisposition } from '../../src/main/runDisposition';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { stepLibraryDir } from '../../src/main/stepLibrary';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createRunResolver } from '../../src/main/runResolver';
import { repoOnlyDefTiers } from '../helpers/defTiers';

describe('step references resolve through the run resolver (§18.2 / §18.7.3)', () => {
  let repo: string;
  let globalDir: string;
  const writeStep = (root: string, name: string, text: string): void => {
    mkdirSync(stepLibraryDir(root), { recursive: true });
    writeFileSync(join(stepLibraryDir(root), `${name}.yaml`), text);
  };
  const writeEntry = (root: string, id: string, flowYaml: string): void => {
    const dir = join(flowCatalogDir(root), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FLOW_DEF_FILE), flowYaml);
  };
  const resolved = (): FlowStepDef[] => {
    const { load } = createRunResolver(globalDir, repoOnlyDefTiers())(repo);
    if (!load.ok) throw new Error(load.error);
    return load.definition.steps;
  };
  const stepsOf = (id: string): FlowStepDef[] => {
    writeActiveFlow(repo, id);
    return resolved();
  };
  const writeFlowFile = (root: string, flowYaml: string): void => {
    mkdirSync(join(root, '.agent-terminal'), { recursive: true });
    writeFileSync(flowDefinitionFile(root), flowYaml);
  };
  const fx = createWorktreeFixture();

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'step-refs-repo-')));
    mkdirSync(join(repo, '.git'));
    globalDir = realpathSync(mkdtempSync(join(tmpdir(), 'step-refs-global-')));
  });
  afterEach(() => {
    fx.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('two flows that reference one global step definition both run its current loop', () => {
    writeStep(globalDir, 'shared-step', 'kind: loop\nloop: plan-loop\n');
    writeEntry(globalDir, 'flow-one', 'name: flow-one\nsteps:\n  - step: shared-step\n');
    writeEntry(globalDir, 'flow-two', 'name: flow-two\nsteps:\n  - id: first\n    kind: manual\n  - step: shared-step\n');
    expect(stepsOf('flow-one').at(-1)?.loop).toBe('plan-loop');
    expect(stepsOf('flow-two').at(-1)?.loop).toBe('plan-loop');

    writeStep(globalDir, 'shared-step', 'kind: loop\nloop: infra-loop\n');
    expect(stepsOf('flow-one').at(-1)?.loop).toBe('infra-loop');
    expect(stepsOf('flow-two').at(-1)?.loop).toBe('infra-loop');
  });

  it('a repository step definition wins over a global one of the same name', () => {
    writeStep(globalDir, 'step-a', 'kind: loop\nloop: plan-loop\n');
    writeStep(repo, 'step-a', 'kind: loop\nloop: infra-loop\n');
    writeEntry(repo, 'clash', 'name: clash\nsteps:\n  - step: step-a\n');
    expect(stepsOf('clash')[0].loop).toBe('infra-loop');
  });

  describe('a global flow uses only global step definitions, so repository content cannot change it', () => {
    beforeEach(() => {
      writeStep(globalDir, 'step-a', 'kind: loop\nloop: plan-loop\n');
      writeStep(repo, 'step-a', 'kind: loop\nloop: infra-loop\n');
    });

    it('a global catalog flow', () => {
      writeEntry(globalDir, 'global-flow', 'name: global-flow\nsteps:\n  - step: step-a\n');
      expect(stepsOf('global-flow')[0].loop).toBe('plan-loop');
    });

    it('a global catalog flow already started, after a repository step file appears', () => {
      writeEntry(globalDir, 'global-flow', 'name: global-flow\nsteps:\n  - step: step-a\n');
      fx.writeFlowState(repo, { step: 'step-a', status: 'in_progress' });
      recordDisposition(repo, { source: 'catalog', tier: 'global', id: 'global-flow' });
      expect(resolved()[0].loop).toBe('plan-loop');
    });

    it('the global default flow', () => {
      writeFlowFile(globalDir, 'name: fallback\nsteps:\n  - step: step-a\n');
      expect(resolved()[0].loop).toBe('plan-loop');
    });

    it('the global default flow already started', () => {
      writeFlowFile(globalDir, 'name: fallback\nsteps:\n  - step: step-a\n');
      fx.writeFlowState(repo, { step: 'step-a', status: 'in_progress' });
      recordDisposition(repo, { source: 'fallback' });
      expect(resolved()[0].loop).toBe('plan-loop');
    });
  });

  describe('a repository flow uses repository step definitions, then global ones', () => {
    it('a local flow.yaml prefers the repository definition', () => {
      writeStep(globalDir, 'step-a', 'kind: loop\nloop: plan-loop\n');
      writeStep(repo, 'step-a', 'kind: loop\nloop: infra-loop\n');
      writeFlowFile(repo, 'name: local\nsteps:\n  - step: step-a\n');
      expect(resolved()[0].loop).toBe('infra-loop');
    });

    it('a local flow.yaml falls back to a global-only definition', () => {
      writeStep(globalDir, 'only-global', 'kind: loop\nloop: plan-loop\n');
      writeFlowFile(repo, 'name: local\nsteps:\n  - step: only-global\n');
      expect(resolved()[0].loop).toBe('plan-loop');
    });
  });
});
