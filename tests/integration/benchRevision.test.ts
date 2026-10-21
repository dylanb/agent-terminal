import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { V2_FLOW_FILE, V3_FLOW, V3_FLOW_FILE } from '../helpers/benchRunSetup';
import { flowDefinitionRevision, promptRevision, type PromptRevisionQuery } from '../../src/main/benchRevision';
import { readUntrustedFlowDefinition, type FlowDefinition } from '../../src/main/flow';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import type { BenchSpan } from '../../src/shared/benchLaunch';

// #180 — the ticket's Definitions: the flow-definition revision changes when, and only when, the loaded flow.yaml's
// bytes change; the prompt revision when, and only when, a loop-definition file, prompt or charter the span's loop
// steps resolve to changes, from whichever tier the app resolves it.

let roots: BenchRoots;
let repoDir: string;
afterEach(() => {
  roots?.cleanup();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

function fresh(): void {
  roots = createBenchRoots();
  repoDir = mkdtempSync(join(tmpdir(), 'bench-revision-repo-'));
}

function definitionOf(file: string): FlowDefinition {
  const { load } = readUntrustedFlowDefinition(file);
  if (!load.ok) throw new Error(`setup: ${file} does not load`);
  return load.definition;
}

const query = (flowFile: string, span: BenchSpan): PromptRevisionQuery => ({
  definition: definitionOf(flowFile),
  span,
  appBundle: roots.bundle,
  userConfigRoot: roots.configDir,
  repoDir,
});

/** A shipped loop's folder in the test's own copy of the bundle. */
const bundledLoop = (flow: string, loop: string): string => join(resolveExampleLoopsV2Dir(roots.bundle), flow, loop);

/** Changes `file`'s bytes and nothing it means: a comment in its own syntax. */
const touch = (file: string): void => appendFileSync(file, file.endsWith('.yaml') ? '\n# edited\n' : '\n<!-- edited -->\n');

describe('the prompt revision', () => {
  it.each([
    { what: 'loop definition', flowFile: V3_FLOW_FILE, flow: 'feature-dev-v3', file: 'red-loop.yaml' },
    { what: 'brief', flowFile: V3_FLOW_FILE, flow: 'feature-dev-v3', file: 'prompts/brief.md' },
    { what: 'work recipe', flowFile: V3_FLOW_FILE, flow: 'feature-dev-v3', file: 'prompts/work.md' },
    { what: 'reviewer charter', flowFile: V3_FLOW_FILE, flow: 'feature-dev-v3', file: 'charter/tests.md' },
    { what: 'consolidator recipe', flowFile: V2_FLOW_FILE, flow: 'feature-dev-v2', file: 'prompts/consolidate.md' },
  ])("changes when the span's loop step's $what changes", ({ flowFile, flow, file }) => {
    fresh();
    const q = query(flowFile, { first: 'red', last: 'red' });
    const before = promptRevision(q);

    touch(join(bundledLoop(flow, 'red-loop'), file));

    expect(promptRevision(q)).not.toBe(before);
  });

  it('stays equal with no edit and with an edit to a loop outside the span, and changes with one to its middle step or its last', () => {
    fresh();
    const q = query(V3_FLOW_FILE, { first: 'red', last: 'refactor' });
    const first = promptRevision(q);
    const unedited = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'plan-goal-loop'), 'plan-goal-loop.yaml'));
    const outside = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'green-loop'), 'green-loop.yaml'));
    const middle = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'refactor-loop'), 'refactor-loop.yaml'));
    const last = promptRevision(q);

    expect({ unedited: unedited === first, outside: outside === first, middle: middle === outside, last: last === middle }).toEqual({
      unedited: true,
      outside: true,
      middle: false,
      last: false,
    });
  });

  it("stays equal when a span loop's bound artifacts or an unreferenced file in its folder change, and changes with its charter", () => {
    fresh();
    const q = query(V3_FLOW_FILE, { first: 'red', last: 'red' });
    const artifacts = join(repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'plan.md'), '# plan\n');
    writeFileSync(join(artifacts, 'impl-report.md'), '# report\n');
    const before = promptRevision(q);
    touch(join(artifacts, 'plan.md'));
    touch(join(artifacts, 'impl-report.md'));
    writeFileSync(join(bundledLoop('feature-dev-v3', 'red-loop'), 'notes.md'), 'not a prompt\n');
    const notPrompts = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'red-loop'), 'charter', 'tests.md'));
    const charter = promptRevision(q);

    expect({ notPromptsEqual: notPrompts === before, charterEqual: charter === notPrompts }).toEqual({ notPromptsEqual: true, charterEqual: false });
  });

  it('follows the operator-tier copy that shadows the shipped one: an edit to it counts, an edit to the shadowed copy does not', () => {
    fresh();
    const q = query(V3_FLOW_FILE, { first: 'red', last: 'red' });
    const shippedOnly = promptRevision(q);
    const operatorLoop = join(userConfigLoopsV2Dir(roots.configDir) ?? '', 'feature-dev-v3', 'red-loop');
    mkdirSync(dirname(operatorLoop), { recursive: true });
    cpSync(bundledLoop('feature-dev-v3', 'red-loop'), operatorLoop, { recursive: true });
    const copied = promptRevision(q);
    touch(join(operatorLoop, 'charter', 'tests.md'));
    const operatorEdited = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'red-loop'), 'charter', 'tests.md'));
    const shadowedEdited = promptRevision(q);

    expect({
      copiedUnchanged: copied === shippedOnly,
      operatorEditCounts: operatorEdited !== copied,
      shadowedEditIgnored: shadowedEdited === operatorEdited,
    }).toEqual({ copiedUnchanged: true, operatorEditCounts: true, shadowedEditIgnored: true });
  });

  it("follows the repository's .agent-loop.yaml override that shadows the shipped one: an edit to it counts, an edit to the shadowed copy does not", () => {
    fresh();
    const q = query(V3_FLOW_FILE, { first: 'red', last: 'red' });
    const shippedOnly = promptRevision(q);
    const repoLoop = join(repoDir, 'loops', 'red-loop');
    cpSync(bundledLoop('feature-dev-v3', 'red-loop'), repoLoop, { recursive: true });
    writeFileSync(join(repoDir, '.agent-loop.yaml'), 'loops:\n  red-loop: loops/red-loop/red-loop.yaml\n');
    const copied = promptRevision(q);
    touch(join(repoLoop, 'charter', 'tests.md'));
    const repoEdited = promptRevision(q);
    touch(join(bundledLoop('feature-dev-v3', 'red-loop'), 'charter', 'tests.md'));
    const shadowedEdited = promptRevision(q);

    expect({
      copiedUnchanged: copied === shippedOnly,
      repoEditCounts: repoEdited !== copied,
      shadowedEditIgnored: shadowedEdited === repoEdited,
    }).toEqual({ copiedUnchanged: true, repoEditCounts: true, shadowedEditIgnored: true });
  });
});

describe('the flow-definition revision', () => {
  it('is equal for equal flow.yaml bytes and differs for different ones', () => {
    expect({ same: flowDefinitionRevision(V3_FLOW) === flowDefinitionRevision(`${V3_FLOW}`), edited: flowDefinitionRevision(`${V3_FLOW}# edited\n`) === flowDefinitionRevision(V3_FLOW) }).toEqual({
      same: true,
      edited: false,
    });
  });
});
