// #180 — every `bench run` refusal, decided before the label, any issue copy, any folder or any launch.

import path from 'node:path';
import type { BenchGithub } from './benchGithub';
import type { BundleLocation } from './bundleLocation';
import { appDefContext } from './appDefContext';
import { actsOnPickupPullRequest } from './appGateGithub';
import { runAppCommand } from './appCommand';
import { readBoundedNoFollow } from './boundedRead';
import { FLOW_DEF_FILE, flowTypedInput, readUntrustedFlowDefinition, type FlowDefinition } from './flow';
import { resolveCatalogEntry } from './flowCatalog';
import { resolveLoopDefV2, type LoopDefV2 } from './loopDefV2';
import { BENCH_FIXTURE_MANIFEST, parseBenchFixture, type BenchFixture } from '../shared/benchFixture';
import type { BenchSpan } from '../shared/benchLaunch';
import { resolveStepSpan } from '../shared/flowStepSpan';
import { APP_LOOP_NAMESPACE } from '../shared/loopNamespace';

export type BenchFlowRef = { kind: 'id'; id: string } | { kind: 'path'; file: string };

export type BenchRefusal =
  | 'flow-unloadable'
  | 'span-unknown-step'
  | 'span-out-of-order'
  | 'runs-invalid'
  | 'fixture-unparsable'
  | 'commit-absent'
  | 'issue-other-repository'
  | 'pr-acting-gate';

export interface BenchRefusalRequest {
  flow: BenchFlowRef;
  span: BenchSpan;
  fixtureDir: string;
  runs: string;
  invokingRepo: string;
  appHome: string;
  userConfigRoot: string | null;
  github: BenchGithub;
  appBundle: BundleLocation;
}

/** What the runner goes on with once nothing is refused. */
export interface BenchAccepted {
  definition: FlowDefinition;
  /** The validated `flow.yaml` text, which a run installs byte for byte. */
  flowText: string;
  /** The directory the validated `flow.yaml` sits in: its flow home. */
  flowHome: string;
  fixture: BenchFixture;
  runs: number;
  /** The flow's `github-ticket` input, which each run sets to its issue copy; none when the flow declares none. */
  ticketInput: string | null;
}

export type BenchRefusalCheck = { ok: true; accepted: BenchAccepted } | { ok: false; code: BenchRefusal };

const MAX_FIXTURE_MANIFEST_BYTES = 64 * 1024;

const refused = (code: BenchRefusal): BenchRefusalCheck => ({ ok: false, code });

function flowFile(request: BenchRefusalRequest): string | null {
  if (request.flow.kind === 'path') return request.flow.file;
  const entry = resolveCatalogEntry({ worktreeDir: request.invokingRepo, globalRoot: request.appHome }, request.flow.id);
  return entry.ok ? path.join(entry.flowDir, FLOW_DEF_FILE) : null;
}

const parseRuns = (runs: string): number | null => (/^[1-9]\d*$/.test(runs) && Number.isSafeInteger(Number(runs)) ? Number(runs) : null);

function readFixture(fixtureDir: string, ticketInput: string | null): BenchFixture | null {
  const read = readBoundedNoFollow(path.join(fixtureDir, BENCH_FIXTURE_MANIFEST), MAX_FIXTURE_MANIFEST_BYTES);
  if (!read.ok) return null;
  const parsed = parseBenchFixture(read.text);
  if (!parsed.ok) return null;
  if (ticketInput !== null && Object.prototype.hasOwnProperty.call(parsed.fixture.inputs, ticketInput)) return null;
  return parsed.fixture;
}

async function commitPresent(repo: string, commit: string): Promise<boolean> {
  try {
    await runAppCommand('git', ['cat-file', '-e', `${commit}^{commit}`], repo);
    return true;
  } catch {
    return false;
  }
}

type LoopDefs = { ok: true; defs: (LoopDefV2 | null)[] } | { ok: false };

/** Each step's §27 loop def, null for a step that binds none; resolved as the app resolves them. */
function loopDefsOf(definition: FlowDefinition, request: BenchRefusalRequest): LoopDefs {
  const ctx = appDefContext(request.appBundle, request.userConfigRoot, request.invokingRepo, definition.name);
  const defs: (LoopDefV2 | null)[] = [];
  for (const step of definition.steps) {
    if (step.kind !== 'loop' || step.loop === undefined || step.loopNamespace !== APP_LOOP_NAMESPACE) {
      defs.push(null);
      continue;
    }
    const resolved = resolveLoopDefV2(step.loop, ctx);
    if (!resolved.ok) return { ok: false };
    defs.push(resolved.def);
  }
  return { ok: true, defs };
}

const actsOnPullRequest = (def: LoopDefV2 | null): boolean =>
  def !== null && def.gate.some((o) => o.sideEffects.some((se) => se.kind === 'gh' && typeof se.args.action === 'string' && actsOnPickupPullRequest(se.args.action)));

export async function checkBenchRefusals(request: BenchRefusalRequest): Promise<BenchRefusalCheck> {
  const file = flowFile(request);
  if (file === null) return refused('flow-unloadable');
  const { load, text } = readUntrustedFlowDefinition(file);
  if (!load.ok || text === null) return refused('flow-unloadable');
  const definition = load.definition;

  const span = resolveStepSpan(
    definition.steps.map((s) => s.id),
    request.span,
  );
  if (!span.ok) return refused(span.cause === 'unknown-step' ? 'span-unknown-step' : 'span-out-of-order');

  const runs = parseRuns(request.runs);
  if (runs === null) return refused('runs-invalid');

  const ticketInput = flowTypedInput(definition, 'github-ticket')?.name ?? null;
  const fixture = readFixture(request.fixtureDir, ticketInput);
  if (fixture === null) return refused('fixture-unparsable');
  if (!(await commitPresent(request.invokingRepo, fixture.commit))) return refused('commit-absent');
  if (fixture.issue.repository !== (await request.github.repositoryOf(request.invokingRepo)).toLowerCase()) return refused('issue-other-repository');

  const loopDefs = loopDefsOf(definition, request);
  if (!loopDefs.ok) return refused('flow-unloadable');
  const pickupIndex = loopDefs.defs.findIndex((def) => def !== null && def.pickup !== null);
  if (pickupIndex >= 0 && span.firstIndex > pickupIndex && loopDefs.defs.slice(span.firstIndex, span.lastIndex + 1).some(actsOnPullRequest)) {
    return refused('pr-acting-gate');
  }

  return { ok: true, accepted: { definition, flowText: text, flowHome: path.dirname(file), fixture, runs, ticketInput } };
}
