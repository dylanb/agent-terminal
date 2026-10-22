import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFakeAgentV2 } from '../e2e/fakeTools';

describe('controller gate input observation', () => {
  it('retains an empty submitted line before the independent-input barrier', () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-input-recorder-'));
    try {
      seedFakeAgentV2(root, { stepId: 'groom', artifactRel: 'artifact.md', work: 'noop', logInjected: true });
      execFileSync('bash', [join(root, 'fake-agent')], { cwd: root, input: '\nC1_INPUT_BARRIER\n' });
      expect(readFileSync(join(root, '.agent-terminal', 'injected-log'), 'utf8')).toBe('\nC1_INPUT_BARRIER\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
