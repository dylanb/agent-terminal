import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlowDefinitionFromFile } from '../../src/main/flow';
import { resolveExampleFlowsDir, resolveExampleStepsDir } from '../../src/main/exampleAssets';
import { createStepLibrary, STEP_DEF_EXT } from '../../src/main/stepLibrary';
import { REPO_DIR } from '../helpers/bundledLoops';

const loc = { packaged: false, appPath: REPO_DIR } as const;
const bundledSteps = createStepLibrary([{ name: 'bundled', dir: resolveExampleStepsDir(loc) }]);

describe('the bundled step library and two-step example load (§18.2)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'two-step-example-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the two-step example loads, and every step it references resolves', () => {
    const load = loadFlowDefinitionFromFile(join(resolveExampleFlowsDir(loc), 'two-step-example-v1', 'flow.yaml'), bundledSteps);
    expect(load.ok, load.ok ? '' : load.error).toBe(true);
    expect(load.ok && load.definition.steps.length).toBe(2);
  });

  it('every bundled step definition loads as a step', () => {
    const names = readdirSync(resolveExampleStepsDir(loc))
      .filter((f) => f.endsWith(STEP_DEF_EXT))
      .map((f) => f.slice(0, -STEP_DEF_EXT.length));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const file = join(tmp, `${name}-flow.yaml`);
      writeFileSync(file, `name: t\nsteps:\n  - step: ${name}\n`);
      const load = loadFlowDefinitionFromFile(file, bundledSteps);
      expect(load.ok, `${name}: ${load.ok ? '' : load.error}`).toBe(true);
    }
  });
});
