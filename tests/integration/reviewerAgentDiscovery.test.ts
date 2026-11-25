import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRunReviewers } from '../../src/main/runReviewers';
import { reviewerAgentFor } from '../../src/main/reviewTurn';
import { rosterLines } from '../../src/main/reviewTurn';
import { reviewerContracts } from '../helpers/reviewerContracts';
import { seedFakeAgentSteps } from '../e2e/fakeTools';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rendered Claude reviewers are discoverable by the names requested in review prompts', () => {
  it.each(reviewerContracts)('$persona preserves its charter and tool declaration', (contract) => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-discovery-'));
    roots.push(root);
    const agents = join(root, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    const charter = join(root, 'charter.md');
    writeFileSync(charter, contract.charter);
    const reviewer = { loop: contract.loop, persona: contract.persona, charter, tools: contract.tools };
    const name = reviewerAgentFor('claude-code', reviewer);
    expect(reconcileRunReviewers(root, reviewerCatalog([reviewer])).problems).toEqual([]);
    const evidence = join(root, 'executed.jsonl');
    seedFakeAgentSteps(root, { check: { artifactRel: '.agent-terminal/loop/artifacts/plan.md', work: 'complete', roster: [contract.persona] } }, {
      reviewers: { expected: [{ ...contract, name }], evidence },
    });
    const lines = rosterLines([reviewer], 'claude-code');
    execFileSync('bash', [join(root, 'fake-agent')], { cwd: root, input: [...lines, 'turn-done:review-check', ''].join('\n') });
    expect(readFileSync(join(root, '.agent-terminal/loop/turn-done'), 'utf8')).toBe('review-check');
    expect(readFileSync(evidence, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { name, charter: contract.charter, tools: contract.tools },
    ]);
  });
});
