// §27.4 — each reviewer runs as a Claude Code sub-agent whose own instructions are its charter.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { confinedRealPathResult, resolveOwnedDirJail } from './confinedPath';
import { readDirEntries } from './dirEntries';
import { errMsg, isErrno } from './errno';
import { resolveLoopDefV2, type ReviewerTools } from './loopDefV2';

const NAME_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The sub-agent type one loop's reviewer persona is installed as. Claude Code discovers it from the file of
 *  the same name, so the installer that writes the file and the prompt that spawns it both take it from here. */
export function reviewerAgentName(loop: string, persona: string): string {
  return `${loop}--${persona}`;
}

export interface ReviewerAgentSpec {
  loop: string;
  persona: string;
  tools: ReviewerTools;
  charter: string;
}

function checkReviewerSpec(spec: ReviewerAgentSpec): void {
  for (const part of [spec.loop, spec.persona]) {
    if (!NAME_SEGMENT.test(part)) throw new Error(`${JSON.stringify(part)} cannot name a reviewer sub-agent: use lowercase letters, digits and single hyphens`);
  }
  if (spec.tools !== 'all' && spec.tools.length === 0) throw new Error(`reviewer ${spec.persona} in ${spec.loop} declares no tools`);
}

/** §18.1 v2.199: Codex rejects an agent name holding anything but lowercase letters, digits and underscores. */
export function codexReviewerAgentName(loop: string, persona: string): string {
  return reviewerAgentName(loop, persona).replaceAll('-', '_');
}

const CODEX_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'Bash']);
export const CODEX_REVIEWER_PREAMBLE = 'You are a reviewer. Never create, edit or delete any file: report your findings only.';
const TOML_LITERAL_CLOSE = "'''";

/** §18.1 v2.199: a Codex subagent runs with its parent's permissions and its file cannot narrow them, so a def
 *  whose explicit list grants more than reading is refused rather than installed as an agent that may write. */
export function renderCodexReviewerAgent(spec: ReviewerAgentSpec): string {
  checkReviewerSpec(spec);
  const granted = spec.tools === 'all' ? [] : spec.tools.filter((t) => !CODEX_READ_ONLY_TOOLS.has(t));
  if (granted.length > 0) throw new Error(`reviewer ${spec.persona} in ${spec.loop} declares ${granted.join(', ')}, which a read-only Codex reviewer cannot be given`);
  if (spec.charter.includes(TOML_LITERAL_CLOSE)) throw new Error(`the charter of ${spec.persona} in ${spec.loop} holds ${TOML_LITERAL_CLOSE}, which a TOML literal string cannot carry`);
  const name = codexReviewerAgentName(spec.loop, spec.persona);
  return [
    `name = "${name}"`,
    `description = "The ${spec.persona} reviewer of the ${spec.loop} loop, installed with the agent-terminal example loops. Its instructions are its charter."`,
    `developer_instructions = ${TOML_LITERAL_CLOSE}`,
    `${CODEX_REVIEWER_PREAMBLE}\n\n${spec.charter}${TOML_LITERAL_CLOSE}`,
    '',
  ].join('\n');
}

export interface ReviewerAgentFormat {
  name: (loop: string, persona: string) => string;
  extension: string;
  render: (spec: ReviewerAgentSpec) => string;
}

export const CLAUDE_REVIEWER_AGENT: ReviewerAgentFormat = { name: reviewerAgentName, extension: '.md', render: renderReviewerAgent };
export const CODEX_REVIEWER_AGENT: ReviewerAgentFormat = { name: codexReviewerAgentName, extension: '.toml', render: renderCodexReviewerAgent };

/** A sub-agent with no `tools:` line inherits every tool, so an empty list is refused rather than installed
 *  as every tool. */
export function renderReviewerAgent(spec: ReviewerAgentSpec): string {
  checkReviewerSpec(spec);
  const name = reviewerAgentName(spec.loop, spec.persona);
  return [
    '---',
    `name: ${name}`,
    `description: The ${spec.persona} reviewer of the ${spec.loop} loop. Spawned by the agent-terminal loop engine's review-and-fix turn; its instructions are its charter, installed with the example loops.`,
    ...(spec.tools === 'all' ? [] : [`tools: ${spec.tools.join(', ')}`]),
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
export function planReviewerAgents(loopsRoot: string, format: ReviewerAgentFormat): PlannedReviewerAgent[] {
  const byName = new Map<string, PlannedReviewerAgent & { rendered: string }>();
  for (const flow of readDirEntries(loopsRoot)) {
    if (!flow.isDirectory) continue;
    for (const loop of readDirEntries(path.join(loopsRoot, flow.name))) {
      if (!loop.isDirectory) continue;
      const r = resolveLoopDefV2(loop.name, { tiers: { operator: null, appBundled: loopsRoot, retired: null }, repoDir: loopsRoot, flow: flow.name });
      if (!r.ok) throw new Error(`the bundled loop ${flow.name}/${loop.name} does not resolve: ${r.reason}`);
      for (const reviewer of r.def.reviewers) {
        const render = (): string => format.render({ loop: loop.name, persona: reviewer.persona, tools: reviewer.tools, charter: readFileSync(reviewer.charter, 'utf8') });
        const rendered = render();
        const name = format.name(loop.name, reviewer.persona);
        const prior = byName.get(name);
        if (prior !== undefined) {
          if (prior.rendered !== rendered) throw new Error(`the bundled flows disagree on the reviewer ${name}: two charters or tool lists cannot install as one sub-agent`);
          continue;
        }
        byName.set(name, { rel: `${name}${format.extension}`, src: reviewer.charter, bytes: () => Buffer.from(render()), rendered });
      }
    }
  }
  return [...byName.values()].map(({ rel, src, bytes }) => ({ rel, src, bytes }));
}

const AGENT_FILE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export interface InstalledReviewer {
  persona: string;
  charter: string;
  tools: ReviewerTools;
  agent: string;
}

/** Why this reviewer cannot run as the sub-agent installed for it carrying the charter and tools the run
 *  resolved, or null when it can. */
export function installedReviewerProblem(agentsDir: string | null, reviewer: InstalledReviewer): string | null {
  if (agentsDir === null) return `there is no Claude Code agents directory to find ${reviewer.agent} in: set CLAUDE_CONFIG_DIR to an absolute path, or unset it to use ~/.claude`;
  const file = path.join(agentsDir, `${reviewer.agent}.md`);
  const missing = `no sub-agent ${reviewer.agent} is installed (${file})`;
  const jail = resolveOwnedDirJail(agentsDir);
  if (jail === null) return missing;
  const real = confinedRealPathResult(jail, file);
  if (!real.ok) return `the sub-agent file ${file} is not inside ${agentsDir}`;
  let text: string;
  try {
    text = readFileSync(real.path, 'utf8');
  } catch (e) {
    return isErrno(e, 'ENOENT') ? missing : `cannot read the sub-agent ${file}: ${errMsg(e)}`;
  }
  const m = AGENT_FILE.exec(text);
  let front: unknown;
  try {
    front = m === null ? null : yaml.load(m[1]);
  } catch {
    front = null;
  }
  if (m === null || typeof front !== 'object' || front === null) return `${file} is not a sub-agent definition`;
  const fields = front as Record<string, unknown>;
  if (fields.name !== reviewer.agent) return `${file} defines the sub-agent ${String(fields.name)}, not ${reviewer.agent}`;
  let charter: string;
  try {
    charter = readFileSync(reviewer.charter, 'utf8');
  } catch (e) {
    return `cannot read the charter ${reviewer.charter}: ${errMsg(e)}`;
  }
  if (m[2] !== charter) return `the sub-agent ${reviewer.agent} carries a different charter than ${reviewer.charter}`;
  const named = (t: ReviewerTools): string => (t === 'all' ? 'every tool' : t.join(', '));
  const tools: ReviewerTools = fields.tools === undefined ? 'all' : typeof fields.tools === 'string' ? fields.tools.split(',').map((t) => t.trim()) : [];
  if (named(tools) !== named(reviewer.tools)) return `the sub-agent ${reviewer.agent} has the tools ${named(tools) || 'none'}, not ${named(reviewer.tools)}`;
  return null;
}
