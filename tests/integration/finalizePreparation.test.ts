import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { loadTodoTemplateFile, parseTodoTemplate } from '../../src/main/todoTemplate';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';

function finalize() {
  const flow = loadUntrustedFlowDefinition(join(resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR }), 'feature-dev-v3', 'flow.yaml'));
  if (!flow.ok) throw new Error(flow.error);
  const step = flow.definition.steps.find((s) => s.id === 'finalize');
  if (step?.kind !== 'loop' || step.loop === undefined) return undefined;
  const resolved = resolveLoopDefV2(step.loop, {
    tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow: 'feature-dev-v3',
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.def;
}

function instructions(): string {
  const def = finalize();
  if (!def) return '';
  return [def.work.goal ?? '', def.brief ? readFileSync(def.brief, 'utf8') : '', readFileSync(def.work.recipe, 'utf8')].join('\n');
}

describe('#251 final preparation contract delivered to the working agent', () => {
  it('starts a resumable goal without reviewer rounds', () => {
    const def = finalize();
    expect(def && { goal: def.work.goal, rounds: def.rounds, reviewers: def.reviewers }).toEqual({
      goal: expect.stringMatching(/\S/), rounds: { kind: 'none' }, reviewers: [],
    });
  });

  it('supplies approved intent, plan and implementation evidence', () => {
    expect(finalize()?.inputs.map((i) => i.id) ?? []).toEqual(expect.arrayContaining(['groom-intent', 'plan', 'impl-report']));
  });

  it('keeps a human approve/redo gate without automatic publishing or merge side effects', () => {
    expect(finalize()?.gate.map((g) => ({ option: g.option, effects: g.sideEffects })) ?? []).toEqual(expect.arrayContaining([
      { option: 'approve', effects: [] }, { option: 'redo', effects: [] },
    ]));
  });

  it('does not seed finalization todos that ask for additional implementation or Copilot reviews', () => {
    const dir = join(resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR }), 'feature-dev-v3');
    const flow = loadUntrustedFlowDefinition(join(dir, 'flow.yaml'));
    if (!flow.ok) throw new Error(flow.error);
    const ref = flow.definition.steps.find((s) => s.id === 'finalize')?.todoTemplate;
    const items = ref ? parseTodoTemplate(loadTodoTemplateFile(join(dir, 'todo-templates'), ref) ?? '') : [];
    expect(items.filter((item) => /^\/goal\s+(?:run.*review|request.*copilot)/i.test(item))).toEqual([]);
  });

  const obligations: [string, RegExp[]][] = [
    ['explicit repository and PR identity, never inferred from the branch', [
      /(?:^|\bmust\s+)(?:inspect|read|use|establish|confirm)\b.*(?:explicit|actual|associated).*(?:repositor.*(?:PR|pull request)|(?:PR|pull request).*repositor)/i,
      /(?:never|do not)\s+infer\b.*(?:identity|identities|PR|pull request|repositor).*branch|(?:never|do not)\s+infer\b.*branch.*(?:identity|identities|PR|pull request|repositor)/i,
    ]],
    ['fetch and reconcile the actual PR target using approved intent', [
      /(?:^|\bmust\s+)fetch\b.*(?:actual|PR|pull request).*(?:base|target)/i,
      /(?:^|\bmust\s+|\band\s+)(?:reconcile|merge|resolve)\b.*(?:approved|settled).*intent/i,
    ]],
    ['resolve behavior conflicts when intent settles them', [
      /(?:^|\bmust\s+)(?:resolve|reconcile)\b.*behavio[u]?r.*conflict.*(?:approved|settled).*intent/i,
    ]],
    ['surface an undecidable conflict and continue after an answer', [
      /intent.*(?:cannot|does not|not settle)|(?:cannot|unresolved).*intent/i,
      /(?:^|\bmust\s+)(?:ask|surface|state|present)\b.*(?:operator|question|decision)/i,
      /(?:^|\bmust\s+)(?:resume|continue)\b.*answer/i,
    ]],
    ['preserve unrelated operator changes and prohibit force-push/reset loss', [
      /(?:^|\bmust\s+)(?:preserve|retain|keep)\b.*unrelated.*(?:work|change)/i,
      /(?:never|do not)\s+force.?push/i,
      /(?:never|do not)\s+(?:reset|force.?push\b.*\bor\s+reset)/i,
    ]],
    ['commit and push relevant reconciliation and CI fixes to the associated PR branch', [
      /(?:^|\bmust\s+)commit\b.*(?:relevant|resolution|fix|changes)|^(?:ensure|make sure).*(?:relevant|resolution|fix|changes).*committed/i,
      /(?:^|\bmust\s+|\band\s+)push\b.*(?:associated|PR|pull request).*branch|^(?:ensure|make sure).*pushed.*(?:associated|PR|pull request).*branch/i,
      /(?:CI|check).*fix|fix.*(?:CI|check)/i,
    ]],
    ['unsuccessful commits remain visibly unready', [/(?:failed|unsuccessful|rejected).*commit.*(?:not|never|cannot).*(?:ready|success|handoff)|(?:do not|never).*(?:failed|unsuccessful|rejected).*commit.*(?:ready|success|handoff)|commit.*(?:fail|unsuccessful).*(?:unverified|unready)/i]],
    ['unsuccessful pushes remain visibly unready', [/(?:failed|unsuccessful|rejected).*push.*(?:not|never|cannot).*(?:ready|success|handoff)|(?:do not|never).*(?:failed|unsuccessful|rejected).*push.*(?:ready|success|handoff)|push.*(?:fail|unsuccessful).*(?:unverified|unready)/i]],
    ['update implementation and verification narrative while retaining unrelated description and closing references', [
      /(?:^|\bmust\s+)update\b.*(?:PR|pull request).*(?:description|body).*(?:final|resulting).*(?:implementation.*verification|verification.*implementation)/i,
      /(?:^|\bmust\s+)(?:preserve|retain|keep)\b.*(?:unrelated|surrounding).*(?:content|description|body)/i,
      /(?:^|\bmust\s+)(?:preserve|retain|keep)\b.*closing.*(?:reference|issue)/i,
    ]],
    ['failed description publication is surfaced without a success claim', [
      /(?:failed|unsuccessful).*publi(?:sh|cation).*(?:not|never|cannot).*(?:ready|success|handoff)|(?:do not|never).*(?:failed|unsuccessful).*publi(?:sh|cation).*(?:ready|success|handoff)|publi(?:sh|cation).*(?:fail|unsuccessful).*(?:unverified|unready)/i,
      /(?:^|\bmust\s+)(?:surface|report|show)\b.*publi(?:sh|cation).*fail/i,
    ]],
    ['check latest remote-head CI even when no new changes or push occur', [
      /(?:latest|current).*remote.*(?:head|revision)|remote.*(?:latest|current).*(?:head|revision)/i,
      /^(?!.*(?:(?:skip|do not|never)\s+(?:check|inspect|verify)|only\s+(?:after|if|when))).*(?:(?:always|every|each).*(?:CI|checks)|(?:CI|checks).*(?:always|every|each))/i,
      /^(?!.*(?:(?:skip|do not|never)\s+(?:check|inspect|verify)|only\s+(?:after|if|when))).*(?:(?:check|inspect|verify).*(?:even|including|regardless|whether).*(?:no|without|nothing).*(?:change|commit|push)|(?:even|including).*(?:no|without|nothing).*(?:change|commit|push).*(?:check|inspect|verify))/i,
    ]],
    ['pending CI is a visible wait and not a pass', [/pending.*(?:not|never|cannot).*(?:pass|success)|(?:not|never).*pending.*(?:pass|success)|pending.*unverified/i, /wait|unverified/i]],
    ['failed CI is fixed within scope and verified again', [
      /(?:^|\bmust\s+)fix\b.*(?:(?:in.scope|within.*scope).*CI.*fail|CI.*fail.*(?:in.scope|within.*scope)|failed.*CI.*within.*scope)/i,
      /(?:^|\bmust\s+)(?:repeat|rerun|re.run)\b.*verif.*(?:after|fix)|(?:^|\bmust\s+)verify\b.*(?:again|after).*fix/i,
    ]],
    ['unavailable or empty checks never count as success', [/unavailable.*(?:not|never|cannot).*(?:pass|success)|(?:not|never).*unavailable.*(?:pass|success)|unavailable.*unverified/i, /(?:empty|no checks).*(?:not|never|cannot).*(?:pass|success)|(?:not|never).*(?:empty|no checks).*(?:pass|success)|(?:empty|no checks).*unverified/i]],
    ['earlier revision success is invalidated by a changed head immediately before handoff', [
      /(?:earlier|stale|previous).*(?:revision|head).*(?:not|never|cannot|invalid|insufficient).*(?:success|ready|readiness|handoff|evidence)|(?:not|never).*(?:accept|use|treat).*(?:earlier|stale|previous).*(?:revision|head)/i,
      /^(?!.*(?:(?:do not|never|skip)\s+(?:re.read|recheck|re.check)|optional)).*(?:re.read|recheck|re.check).*(?:head|revision).*(?:before|immediately).*handoff/i,
      /(?:chang.*(?:head|revision)|(?:head|revision).*chang).*(?:invalid|reassess)/i,
    ]],
    ['required local verification and RED-first fixes receive no new waiver', [
      /^(?!.*(?:(?:skip|do not|never)\s+(?:perform|run|verify|require|check|local)|optional|not required)).*(?:(?:must|required|require|always).*local.*(?:test|check|verif)|local.*(?:test|check|verif).*(?:must|required|require|always))/i,
      /^(?!.*(?:skip|omit|do not).*RED.first).*RED.first/i,
      /(?:no|not|never).*(?:new waiver|waive|waiver)/i,
    ]],
    ['use existing review evidence without requesting reviewers or Copilot reviews', [
      /existing.*review/i,
      /(?:do not|never)\s+(?:run|start|invoke|request).*(?:additional|new).*(?:implementation|reviewer|review)/i,
      /(?:do not|never)\s+(?:request|(?:run|start|invoke)\b.*\b(?:or|and)\s+request)\b.*Copilot.*review/i,
    ]],
    ['retain truthful engine lifecycle and human completion/merge ownership', [
      /(?:^|\bmust\s+)(?:stop|wait)\b.*(?:human|operator).*(?:complete|completion).*merge/i,
      /(?:never|do not)\s+(?:automatically\s+)?complete\b.*flow/i,
      /(?:never|do not)\s+(?:automatically\s+)?merge\b.*(?:PR|pull request)/i,
      /(?:never|do not)\s+(?:fabricate|invent|emit)\b.*completion.*event/i,
    ]],
  ];

  it.each(obligations)('%s', (_name, required) => {
    const clauses = instructions().split(/[.!?;](?:\s|$)|\n+/).map((clause) => clause.replace(/\s+/g, ' '));
    for (const obligation of required) expect.soft(clauses.some((clause) => obligation.test(clause)), String(obligation)).toBe(true);
  });
});
