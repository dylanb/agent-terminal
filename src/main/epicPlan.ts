// Epic classification of a plan (§26.9 / L8). The plan-phase work-agent classifies a plan an epic by
// writing a `classification: epic` field (with the sub-ticket breakdown) into `.agent-loop/plan.md` — the
// signal is DATA in plan.md, not a state-machine status. This recovers it from a leading YAML frontmatter
// block. plan.md is LLM-written and outside the app's control, so every failure mode degrades to
// "not an epic" and this never throws (the §26.9/§26.10 best-effort discipline).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';

/** One sub-ticket of an epic plan: the title epic-promote opens the sub-issue with + its optional body. */
export interface SubTicket {
  title: string;
  body: string;
}

/** The epic classification of the current plan. `isEpic` gates epic-promote (§26.9); `subTickets` is the
 *  breakdown it creates the N-1 sub-issues from (the current PR is sub-ticket-1). */
export interface EpicPlan {
  isEpic: boolean;
  subTickets: SubTicket[];
}

const NOT_EPIC: EpicPlan = { isEpic: false, subTickets: [] };

/** The leading `---`-fenced YAML block of a markdown doc, or null when the doc has no frontmatter. */
function frontmatter(text: string): string | null {
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return m ? m[1] : null;
}

/** One raw `sub_tickets[]` entry → SubTicket, or null when it carries no title (dropped, best-effort). */
function toSubTicket(raw: unknown): SubTicket | null {
  if (!isRecord(raw) || typeof raw.title !== 'string' || raw.title.length === 0) return null;
  return { title: raw.title, body: typeof raw.body === 'string' ? raw.body : '' };
}

/** Read the epic classification from `<repoDir>/.agent-loop/plan.md`. Not an epic when plan.md is absent,
 *  has no frontmatter, the frontmatter is unparseable, or `classification` is anything but `epic`. */
export function readEpicPlan(repoDir: string): EpicPlan {
  let text: string;
  try {
    text = readFileSync(path.join(repoDir, '.agent-loop', 'plan.md'), 'utf8');
  } catch {
    return NOT_EPIC;
  }
  const fm = frontmatter(text);
  if (fm === null) return NOT_EPIC;
  let doc: unknown;
  try {
    doc = yaml.load(fm);
  } catch {
    return NOT_EPIC;
  }
  if (!isRecord(doc) || doc.classification !== 'epic') return NOT_EPIC;
  const subTickets = Array.isArray(doc.sub_tickets)
    ? doc.sub_tickets.map(toSubTicket).filter((t): t is SubTicket => t !== null)
    : [];
  return { isEpic: true, subTickets };
}
