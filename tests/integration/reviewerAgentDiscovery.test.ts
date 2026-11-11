import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCodexReviewerAgent, renderReviewerAgent } from '../../src/main/reviewerAgents';
import { shellQuote } from '../../src/shared/shellQuote';
import { codexReviewerInstructions, reviewerContracts } from '../helpers/reviewerContracts';
import { prepareReviewerSession } from '../e2e/reviewerSession';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('rendered reviewers carry their contract into a fresh scripted session', () => {
  for (const kind of ['claude', 'codex'] as const) {
    it.each(reviewerContracts)(`${kind} exposes the declared instructions and tools: $charter`, (contract) => {
      const root = mkdtempSync(join(tmpdir(), 'reviewer-discovery-'));
      roots.push(root);
      const agentsDir = join(root, 'agents');
      mkdirSync(agentsDir);
      const name = kind === 'claude' ? 'quality-loop--check-contracts' : 'quality_loop__check_contracts';
      const expected = { name, instructions: kind === 'claude' ? contract.charter : codexReviewerInstructions(contract.charter) };
      const spec = { ...contract, tools: contract.tools === 'all' ? 'all' as const : [...contract.tools] };
      writeFileSync(join(agentsDir, name + (kind === 'claude' ? '.md' : '.toml')),
        kind === 'claude' ? renderReviewerAgent(spec) : renderCodexReviewerAgent(spec));
      const session = prepareReviewerSession(root, kind === 'claude'
        ? { kind, agentsDir, reviewers: [{ ...expected, tools: contract.tools }] }
        : { kind, agentsDir, reviewers: [expected] });
      const line = `- check-contracts — ${kind === 'claude' ? 'subagent_type' : 'agent'}: ${name}`;
      execFileSync('bash', ['-c', `${session.startupShell}\nline=${shellQuote(line)}\n${session.observeLineShell}`]);
      const executed: unknown = JSON.parse(readFileSync(session.executions, 'utf8').trim());
      expect(executed).toMatchObject(kind === 'claude' ? { ...expected, tools: contract.tools } : expected);
    });
  }
});
