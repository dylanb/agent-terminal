// tests/unit/n8SweepGuards.test.ts AC8 reads the pre-sweep changelog at `git merge-base HEAD origin/main` (§D.4).
// A default `pull_request` checkout is shallow and single-branch, so origin/main is absent and the merge-base
// aborts — red only in CI, green in every local run. This binds `fetch-depth: 0` to the workflow so a checkout
// regression fails here instead.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

describe('test CI workflow fetches full history for the n8Sweep merge-base guard', () => {
  const wf = yaml.load(readFileSync(resolve('.github/workflows/test.yml'), 'utf8')) as Workflow;
  const checkout = wf.jobs.test.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout'));

  it('the test job checks out with actions/checkout', () => {
    expect(checkout, 'no actions/checkout step in the test job').toBeDefined();
  });

  it('checks out full history so origin/main resolves for git merge-base', () => {
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
