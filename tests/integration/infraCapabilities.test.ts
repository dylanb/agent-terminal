import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';

// §28.6
const RECORD_FILE = 'infra-capabilities.md';
const BUILT_HEADING = '## Capabilities built';
const LARGE_HEADING = '## Large capabilities';
const FOLLOW_UP_HEADING = '## Follow-up proposals';
const OPERATOR_DECISION = 'Operator decision (';
const USED_BY_THIS_TICKET = 'used by at least one slice of this ticket';
const PRECEDENCE = 'takes precedence over `clean` and `another round`';

const repoDir = resolve(__dirname, '..', '..');
const bundle = resolveExampleLoopsV2Dir({ packaged: false, appPath: repoDir });

function infraDef(): LoopDefV2 {
  const r = resolveLoopDefV2('infra-loop', { tiers: { operator: null, appBundled: bundle, retired: null }, repoDir, flow: FEATURE_DEV_ID });
  if (!r.ok) throw new Error(r.reason);
  return r.def;
}
const flat = (path: string): string => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const recipe = (): string => {
  const def = infraDef();
  return `${flat(def.brief!)} ${flat(def.work.recipe)}`;
};

describe('infra adds proportionate deterministic capabilities and settles large ones with the operator', () => {
  it('the work turn records every capability under the three headings, each large one and follow-up decided', () => {
    const body = recipe();
    for (const marker of [RECORD_FILE, BUILT_HEADING, LARGE_HEADING, FOLLOW_UP_HEADING, OPERATOR_DECISION, USED_BY_THIS_TICKET]) {
      expect(body, marker).toContain(marker);
    }
  });

  it('the work turn interviews the operator in business language, with no question limit, before building a large one', () => {
    const body = recipe();
    for (const marker of ['interview the operator', 'plain business language', 'full context', 'no question limit']) {
      expect(body, marker).toContain(marker);
    }
    expect(body.indexOf('interview the operator')).toBeLessThan(body.indexOf('Then build'));
  });

  it('declares the record file as an output, so it lives among the flow documents', () => {
    expect(infraDef().outputs.map((o) => o.rel.split('/').pop())).toContain(RECORD_FILE);
  });

  it('every infra reviewer looks for missing capabilities in its lens and routes a large one to the operator', () => {
    for (const rev of infraDef().reviewers) {
      const charter = flat(rev.charter);
      for (const marker of [RECORD_FILE, USED_BY_THIS_TICKET, 'needs a human']) expect(charter, `${rev.persona}: ${marker}`).toContain(marker);
    }
  });

  it('the consolidator stops for a human on any undecided large capability or follow-up, ahead of every other verdict', () => {
    const body = flat(infraDef().consolidator);
    for (const marker of [RECORD_FILE, LARGE_HEADING, FOLLOW_UP_HEADING, OPERATOR_DECISION, PRECEDENCE]) expect(body, marker).toContain(marker);
  });
});
