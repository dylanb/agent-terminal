// `agent-terminal --validate-flow <dir>` on a flow whose step sets `todo_template` to an empty string, which a
// run treats as no template.

import { expect, test } from '@playwright/test';
import { flowLocations, writeFlow } from '../helpers/flowFixtures';
import { PASSED, passOutcome, useValidateRuntime } from './validateFlowHarness';

test.describe('agent-terminal --validate-flow and an empty todo template', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();

  test('a step whose todo_template is empty passes, as a run seeds no template for it', async () => {
    const repo = runtime.world().dir('repo');
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    writeFlow(folder, { name: 'f', steps: [{ id: 'blank', kind: 'manual', todoTemplate: '' }] });
    expect(passOutcome(await runtime.validate([folder], { cwd: repo }))).toEqual(PASSED);
  });
});
