import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstallExamples, exampleInstallDirs } from '../../src/main/installExamples';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';

let root: string;
let operator: string;
let repo: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'installed-finalize-audit-'));
  repo = join(root, 'target-repository');
  mkdirSync(repo);
  const dirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, {
    flowGlobalDir: join(root, 'flows'), configDir: join(root, 'config'), codexHome: join(root, '.codex'),
  });
  applyInstallExamples(dirs, []);
  const destination = dirs.find((dir) => dir.id === 'appLoops')?.targetDir;
  if (!destination) throw new Error('no installed loop destination');
  operator = destination;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function contract() {
  const resolved = resolveLoopDefV2('finalize-loop', {
    repoDir: repo, flow: 'feature-dev-v3', tiers: { operator, appBundled: join(root, 'absent-bundle'), retired: null },
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  const def = resolved.def;
  const text = [def.work.goal ?? '', def.brief ? readFileSync(def.brief, 'utf8') : '', readFileSync(def.work.recipe, 'utf8')].join('\n');
  return { def, text, clauses: text.split(/\n+|[.!?;](?:\s|$)/).map((line) => line.replace(/\s+/g, ' ')) };
}

function affirmative(clause: string) {
  return !/\b(?:do not|don't|must not|never|omit|exclude|avoid)\b/i.test(clause);
}

describe('#251 complete audit contract delivered to the finalization agent', () => {
  it.each(['audit-evidence', 'publish-flow-audit'])('directs the working agent to the delivered %s operation', (operation) => {
    expect(contract().text).toContain(operation);
  });

  it.each([
    'Scope and status',
    'Execution and decisions',
    'Stage timeline and elapsed time',
    'Exceptions, blocks and checklist outcomes',
    'Evidence gaps and follow-up',
    'Finalize work and PR readiness',
    'Review findings and resolutions',
    'Sources',
  ])('requires the %s section', (section) => {
    expect(contract().clauses.some((clause) => affirmative(clause) && clause.toLowerCase().includes(section.toLowerCase()))).toBe(true);
  });

  it('makes matching audit publication part of the goal before the human gate', () => {
    expect(contract().def.work.goal).toMatch(/audit.*(?:publish|publication)|(?:publish|publication).*audit/i);
  });

  it('requires delivery of the full audit in this finalization run', () => {
    expect(contract().text).not.toMatch(/(?:does not yet deliver|belongs to the next planned increment)/i);
  });

  const obligations: [string, RegExp[], boolean?][] = [
    ['concise decision table with step and evidence-supported rationale', [
      /decision.*table/i, /decision.*(?:sentence|paragraph|concise)/i, /(?:decision|rationale).*step|step.*(?:decision|rationale)/i,
      /rationale.*(?:evidence|supported)|(?:evidence|supported).*rationale/i,
    ]],
    ['combined stage timeline with entry, exit, total elapsed and approval-gate durations', [
      /(?:entry|enter).*(?:exit|leave)/i, /total.*elapsed/i, /(?:approval|gate).*duration/i,
    ]],
    ['elapsed and gate times are not invented active or idle work', [
      /elapsed.*(?:not|never).*active|(?:not|never).*elapsed.*active/i,
      /gate.*(?:not|never).*idle|(?:not|never).*gate.*idle/i,
    ], true],
    ['step-attributed exceptions, dispositions, blocks and checklist counts', [
      /exception.*disposition/i, /(?:group|attribute).*step/i,
      /block.*reason|reason.*block/i,
      /(?:completed.*(?:count|number)|(?:count|number).*completed)/i, /unfinished.*(?:item|summary)|summari.*unfinished/i,
    ]],
    ['outside-todo questions with truthful missing text and attribution', [
      /question.*outside.*todo|outside.*todo.*question/i,
      /question.*step|step.*question/i,
      /(?:question|attribution).*(?:unavailable|unrecorded)|(?:unavailable|unrecorded).*(?:question|attribution)/i,
    ]],
    ['existing implementation and Copilot findings with supported fixed/dismissed reasons', [
      /existing.*(?:implementation.*Copilot|Copilot.*implementation)/i,
      /(?:fix.*dismiss|dismiss.*fix).*(?:reason|why)|(?:reason|why).*(?:fix.*dismiss|dismiss.*fix)/i,
    ]],
    ['sources disclose audit, step reports, Git history, GitHub and coverage gaps', [
      /audit.*(?:log|stream)/i, /step.*report/i, /Git history/i, /GitHub.*(?:result|evidence)/i, /(?:source|evidence).*coverage/i,
    ]],
    ['omit token and cost reporting', [
      /(?:omit|exclude|do not|never).*(?:token.*cost|cost.*token)/i,
    ], true],
    ['read evidence for the authoritative run rather than a basename collision', [
      /audit.*(?:repoPath|absolute.*path|run.*identity)|(?:repoPath|absolute.*path|run.*identity).*audit/i,
      /(?:missing|unreadable|mismatch).*evidence.*unavailable|unavailable.*(?:missing|unreadable|mismatch)/i,
    ]],
    ['retain repeated visits, todo edits/deletions and incomplete intervals', [
      /(?:repeated|repeat).*visit/i, /todo.*(?:edit|change).*delet|todo.*delet.*(?:edit|change)/i,
      /incomplete.*(?:interval|duration)|(?:interval|duration).*incomplete/i,
    ]],
    ['verify remote report matches the local artifact before successful handoff', [
      /(?:remote|published).*(?:match|equal).*(?:local|artifact)|(?:local|artifact).*(?:match|equal).*(?:remote|published)/i,
    ]],
    ['development completion is a reporting convention distinct from remaining finalize and human actions', [
      /(?:reach|enter).*finalize.*development.*complete.*reporting|reporting.*(?:reach|enter).*finalize.*development.*complete/i,
      /(?:remaining|unfinished|separate).*finaliz|finaliz.*(?:remaining|unfinished|separate)/i,
      /(?:human|operator).*(?:completion|complete).*merge/i,
    ]],
    ['absence of an engine completion event alone is not an unresolved audit problem', [
      /(?:absen|missing|lack).*completion.*(?:not|never).*(?:problem|gap|unresolved)|(?:not|never).*(?:absen|missing|lack).*completion.*(?:problem|gap|unresolved)/i,
    ], true],
    ['report scope identifies the flow, ticket, PR and reporting period', [
      /(?:scope|report).*flow|flow.*(?:scope|report)/i,
      /(?:scope|report).*ticket|ticket.*(?:scope|report)/i,
      /(?:scope|report).*\bPR\b|\bPR\b.*(?:scope|report)/i,
      /reporting period/i,
    ]],
    ['report includes finalization work even when historical audit coverage omits it', [
      /(?:report|include).*finaliz.*work.*(?:even|whether|regardless).*(?:audit|historical)|finaliz.*work.*(?:report|include).*(?:even|whether|regardless).*(?:audit|historical)/i,
    ]],
  ];

  it.each(obligations)('%s', (_name, required, permitsProhibition) => {
    const { clauses } = contract();
    for (const obligation of required) {
      expect.soft(clauses.some((clause) => (permitsProhibition || affirmative(clause)) && obligation.test(clause)), String(obligation)).toBe(true);
    }
  });
});
