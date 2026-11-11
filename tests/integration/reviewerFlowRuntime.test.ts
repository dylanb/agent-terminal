import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { renderCodexReviewerAgent, renderReviewerAgent, installedCodexReviewerProblem, installedReviewerProblem } from '../../src/main/reviewerAgents';
import { parse as parseToml } from 'smol-toml';
import { createAppLoopEngineHarness } from '../helpers/appLoopEngineHarness';
import { writeLoopDef } from '../helpers/flowFixtures';

const h = createAppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

for (const kind of ['claude-code', 'codex'] as const) {
  for (const mode of ['ordinary', 'goal'] as const) {
    describe(`${kind} ${mode} flow-aware runtime roster`, () => {
      it('requests its resolved flow reviewer rather than the same persona from another flow', () => {
        const loops = join(h.repo, 'bundled-loops');
        const file = writeLoopDef(loops, 'quality-loop', {
          charters: ['review.md'], artifact: 'commits',
          ...(mode === 'ordinary' ? { consolidator: 'consolidate.md' } : {}),
        }, { flow: 'cedar' });
        if (mode === 'goal') {
          const doc = yaml.load(readFileSync(file, 'utf8')) as { work: Record<string, unknown> };
          doc.work.goal = 'the contract holds';
          writeFileSync(file, yaml.dump(doc));
        }
        const resolved = resolveLoopDefV2('quality-loop', {
          repoDir: h.repo, flow: 'cedar', tiers: { operator: null, appBundled: loops, retired: null },
        });
        if (!resolved.ok) throw new Error(resolved.reason);
        const name = (flow: string): string => {
          const spec = { flow, loop: 'quality-loop', persona: 'reviewer-1', tools: 'all' as const,
            charter: readFileSync(join(dirname(file), 'review.md'), 'utf8') };
          return kind === 'codex'
            ? String(parseToml(renderCodexReviewerAgent(spec)).name)
            : String((yaml.load(renderReviewerAgent(spec).split('---\n')[1]) as { name: string }).name);
        };
        const agents = join(h.repo, 'agents');
        mkdirSync(agents);
        const installed = { flow: 'cedar', loop: 'quality-loop', persona: 'reviewer-1', tools: 'all' as const,
          charter: readFileSync(join(dirname(file), 'review.md'), 'utf8') };
        writeFileSync(join(agents, name('cedar') + (kind === 'codex' ? '.toml' : '.md')),
          kind === 'codex' ? renderCodexReviewerAgent(installed) : renderReviewerAgent(installed));
        const engine = h.makeEngine(undefined, undefined, undefined, {
          resolveDef: () => resolved, hostedAgentKind: () => kind,
          reviewerAgentProblem: (reviewer) => kind === 'codex'
            ? installedCodexReviewerProblem(agents, reviewer) : installedReviewerProblem(agents, reviewer),
        });
        engine.enter(h.repo, 'quality-loop', 'plan', 'chain-advance');
        engine.onInjectable();
        if (mode === 'ordinary') {
          engine.onDoneSignal();
          engine.onInjectable();
          engine.onInjectable();
        }
        const prompt = mode === 'ordinary'
          ? h.injected.find((p) => p.startsWith('This is the review-and-fix turn')) ?? ''
          : (() => {
              const command = h.injected.find((p) => p.startsWith('/goal ')) ?? '';
              const rel = /\.agent-terminal\/\S+\.md/.exec(command)?.[0];
              return rel === undefined ? '' : readFileSync(join(h.repo, rel), 'utf8');
            })();
        const marker = kind === 'codex' ? 'agent: ' : 'subagent_type: ';
        expect.soft(prompt).toContain(marker + name('cedar'));
        expect.soft(prompt).not.toContain(marker + name('birch'));
      });
    });
  }
}
