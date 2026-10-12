// What the stand-in reads out of a composed loop prompt, as a real agent would read it. The phrasings matched
// here are the ones the engine's composers emit (doneSignalInstruction, composeAppWorkPrompt,
// composeReviewAndFixPrompt, composeConsolidatePrompt); benchInfra.test.ts feeds this reader prompts built by
// those composers, so a change to their wording fails there instead of silently stalling a whole-run test.

import { parseAppTurnKey, type AppTurnPhase } from '../../../src/main/appTurnKey';

export type TurnPhase = AppTurnPhase;

export interface ReadPrompt {
  key: string | null;
  phase: TurnPhase | null;
  step: string | null;
  doneRel: string | null;
  artifactRel: string | null;
  reportRel: string | null;
  verdictRel: string | null;
  roster: { persona: string; charter: string | null }[];
  sections: string[];
  catalog: string[];
  inputRels: string[];
}

const list = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function readPrompt(prompt: string): ReadPrompt {
  const lines = prompt.split('\n');
  const key = prompt.match(/\(turn-done:([^)\s]+)\)/)?.[1] ?? null;
  const parsed = key === null ? null : parseAppTurnKey(key);
  let doneRel: string | null = null;
  let artifactRel: string | null = null;
  let reportRel: string | null = null;
  let verdictRel: string | null = null;
  let verdictNext = false;
  let sections: string[] = [];
  let catalog: string[] = [];
  const roster: ReadPrompt['roster'] = [];
  const inputRels: string[] = [];
  let block: 'roster' | 'inputs' | null = null;
  for (const line of lines) {
    if (block === 'roster') {
      const m = line.match(/^- (.+?) — (.+)$/);
      if (m) {
        roster.push({ persona: m[1].trim(), charter: m[2].trim() });
        continue;
      }
      block = null;
    }
    if (block === 'inputs') {
      const m = line.match(/^ {2}- [^:]+: (.+)$/);
      if (m) {
        inputRels.push(m[1].trim());
        continue;
      }
      block = null;
    }
    if (line.startsWith('Reviewers (persona — charter):')) block = 'roster';
    else if (line.startsWith('INPUTS — ')) block = 'inputs';
    const done = key === null ? null : line.match(new RegExp(`^(\\S+) with its only contents being exactly: ${escape(key)}$`));
    if (done) doneRel = done[1];
    const artifact = line.match(/As the final line of your (\S+) artifact/);
    if (artifact) artifactRel = artifact[1];
    const report = line.match(/^Then write the round report to (\S+), a Markdown document/) ?? line.match(/^The round report (\S+) is on disk but fails/);
    if (report) reportRel = report[1];
    const verdict = line.match(/^The verdict (\S+) is on disk but fails/) ?? (verdictNext ? line.match(/^(\S+) as a Markdown document with these labelled lines:$/) : null);
    if (verdict) verdictRel = verdict[1];
    verdictNext = line.endsWith('Then write your verdict to');
    const sec = line.match(/heading for each of these sections: (.+)$/);
    if (sec) sections = list(sec[1]);
    const cat = line.match(/the reviewer catalog below \(.*\): (.+)$/);
    if (cat) catalog = list(cat[1]);
    const repairRoster = line.match(/EVERY reviewer of this round \((.+)\)/);
    if (repairRoster && roster.length === 0) for (const p of list(repairRoster[1])) roster.push({ persona: p, charter: null });
  }
  return {
    key,
    phase: parsed?.phase ?? null,
    step: parsed?.stepId ?? null,
    doneRel,
    artifactRel,
    reportRel,
    verdictRel,
    roster,
    sections,
    catalog,
    inputRels,
  };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
