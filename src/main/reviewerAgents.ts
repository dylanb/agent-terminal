// §27.4 — each reviewer runs as a Claude Code sub-agent whose own instructions are its charter.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDirEntries } from './dirEntries';
import { resolveLoopDefV2 } from './loopDefV2';

const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The sub-agent type one loop's reviewer persona is installed as. Claude Code discovers it from the file of
 *  the same name, so the installer that writes the file and the prompt that spawns it both take it from here. */
export function reviewerAgentName(loop: string, persona: string): string {
  return `${loop}--${persona}`;
}

export interface ReviewerAgentSpec {
  loop: string;
  persona: string;
  tools: readonly string[];
  charter: string;
}

/** A sub-agent with no `tools:` line inherits every tool, so a reviewer declaring none is refused rather than
 *  installed with write access it was never given. */
export function renderReviewerAgent(spec: ReviewerAgentSpec): string {
  for (const part of [spec.loop, spec.persona]) {
    if (!NAME_SEGMENT.test(part)) throw new Error(`${JSON.stringify(part)} cannot name a reviewer sub-agent: use lowercase letters, digits and single hyphens`);
  }
  if (spec.tools.length === 0) throw new Error(`reviewer ${spec.persona} in ${spec.loop} declares no tools`);
  const name = reviewerAgentName(spec.loop, spec.persona);
  return [
    '---',
    `name: ${name}`,
    `description: The ${spec.persona} reviewer of the ${spec.loop} loop. Spawned by the agent-terminal loop engine's review-and-fix turn; its instructions are its charter, installed with the example loops.`,
    `tools: ${spec.tools.join(', ')}`,
    '---',
    spec.charter,
  ].join('\n');
}

export interface PlannedReviewerAgent {
  rel: string;
  /** The charter the file is rendered from — what the file installs, read afresh each time it is asked for. */
  src: string;
  bytes: () => Buffer;
}

/** Every reviewer of every loop def in a loops-v2 tree (`<root>/<flow>/<loop>/<loop>.yaml`), one file per
 *  sub-agent name. Two flows shipping one loop's persona must ship the same charter and tools: one name
 *  cannot carry two charters. */
export function planReviewerAgents(loopsRoot: string): PlannedReviewerAgent[] {
  const byName = new Map<string, PlannedReviewerAgent & { rendered: string }>();
  for (const flow of readDirEntries(loopsRoot)) {
    if (!flow.isDirectory) continue;
    for (const loop of readDirEntries(path.join(loopsRoot, flow.name))) {
      if (!loop.isDirectory) continue;
      const r = resolveLoopDefV2(loop.name, { tiers: { operator: null, appBundled: loopsRoot, retired: null }, repoDir: loopsRoot, flow: flow.name });
      if (!r.ok) throw new Error(`the bundled loop ${flow.name}/${loop.name} does not resolve: ${r.reason}`);
      for (const reviewer of r.def.reviewers) {
        const render = (): string => renderReviewerAgent({ loop: loop.name, persona: reviewer.persona, tools: reviewer.tools, charter: readFileSync(reviewer.charter, 'utf8') });
        const rendered = render();
        const name = reviewerAgentName(loop.name, reviewer.persona);
        const prior = byName.get(name);
        if (prior !== undefined) {
          if (prior.rendered !== rendered) throw new Error(`the bundled flows disagree on the reviewer ${name}: two charters or tool lists cannot install as one sub-agent`);
          continue;
        }
        byName.set(name, { rel: `${name}.md`, src: reviewer.charter, bytes: () => Buffer.from(render()), rendered });
      }
    }
  }
  return [...byName.values()].map(({ rel, src, bytes }) => ({ rel, src, bytes }));
}
