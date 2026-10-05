// Helpers only the #137 auto-gate e2e uses (§27.9.1), built on the shared fake tools.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import type { Page } from '@playwright/test';
import type { FlowStateView } from '../../src/shared/ipc';
import { catalogEntryDefFile } from '../../src/main/flow';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream, stepWindowEvents, type AuditEvent } from '../../src/shared/audit';
import { exampleConfigDir, writeCatalogEntry } from './fakeTools';

export type AutoGateLoop = 'groom-loop' | 'plan-bundle-loop' | 'red-loop' | 'green-loop' | 'refactor-loop';

export interface AutoGateStep {
  id: string;
  kind: 'loop' | 'manual';
  loop?: AutoGateLoop;
  authority?: 'human' | 'auto';
}

/** The review roster a shipped example loop declares, for the fake agent's round reports. */
export function loopRoster(loop: AutoGateLoop): string[] {
  const def = load(readFileSync(join(exampleConfigDir, 'loops-v2', loop, `${loop}.yaml`), 'utf8')) as { reviewers?: { persona?: unknown }[] } | null;
  const personas = (def?.reviewers ?? []).map((r) => r.persona);
  if (personas.length === 0 || !personas.every((p): p is string => typeof p === 'string')) throw new Error(`loopRoster: ${loop} declares no reviewer personas`);
  return personas;
}

/** The one flow builder for the auto-gate e2e. A `groom-loop` step always carries a required `github-ticket`
 *  input named `ticket` (supplied at Start by `provideGroomTicket`); an omitted `authority` writes no
 *  `gate_authority` key. */
export function autoGateFlowYaml(steps: AutoGateStep[], name = 'auto-gate'): string {
  const lines = [`name: ${JSON.stringify(name)}`, 'steps:'];
  for (const s of steps) {
    lines.push(`  - id: ${s.id}`, `    kind: ${s.kind}`);
    if (s.kind === 'loop') {
      if (s.loop === undefined) throw new Error(`autoGateFlowYaml: loop step "${s.id}" names no loop`);
      lines.push(`    loop: ${s.loop}`, '    loop_namespace: app');
      if (s.loop === 'groom-loop') {
        lines.push('    inputs:', '      - name: ticket', '        type: github-ticket', '        required: true');
      }
    }
    if (s.authority !== undefined) lines.push(`    gate_authority: ${s.authority}`);
  }
  return `${lines.join('\n')}\n`;
}

/** An operator-catalog flow (the global tier under `home`) made active for `repo` — an N9b.2-trusted run. */
export function seedTrustedFlow(home: string, repo: string, id: string, yaml: string): void {
  writeCatalogEntry(home, id, yaml);
  writeActiveFlow(repo, id);
}

/** A flow in `repo`'s own per-repo catalog made active for it — the untrusted repo-content case. */
export function seedRepoCatalogFlow(repo: string, id: string, yaml: string): void {
  const file = catalogEntryDefFile(repo, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml);
  writeActiveFlow(repo, id);
}

/** Supply the groom step's `ticket` input at Start, through the same channel the input modal uses. */
export function provideGroomTicket(page: Page, repo: string, ticket = '176'): Promise<FlowStateView> {
  return page.evaluate(([repoKey, t]) => window.flow.provideInput(repoKey, 'groom', { ticket: t }), [repo, ticket] as const);
}

export interface AuditRunIdentity {
  flow: string;
  startedAt: number;
}

export interface GateEntry {
  cmd: string;
  exit: number | null;
}

function runIdentity(repo: string): AuditRunIdentity {
  const file = `${repo}/.agent-terminal/flow-state.yaml`;
  if (!existsSync(file)) throw new Error(`auditGateEntries: ${file} is missing`);
  const doc = load(readFileSync(file, 'utf8')) as { flow?: unknown; started_at?: unknown } | null;
  if (typeof doc?.started_at !== 'number') throw new Error('auditGateEntries: flow-state.yaml has no started_at');
  if (typeof doc.flow !== 'string') throw new Error('auditGateEntries: flow-state.yaml has no flow');
  return { flow: doc.flow, startedAt: doc.started_at };
}

/** The §25 gate command entries of one run, resolved with the writer's own `auditFilePath` from the run's
 *  identity (`flow-state.yaml`, or `opts.run` for a run whose state a Terminate cleared), optionally scoped to
 *  `step`'s last entry window. A missing file, identity or step throws, so an empty read never satisfies a
 *  "none" assertion. */
export function auditGateEntries(home: string, repo: string, opts: { run?: AuditRunIdentity; step?: string } = {}): GateEntry[] {
  const run = opts.run ?? runIdentity(repo);
  const file = auditFilePath(auditRootDir(home), repo, run.flow, new Date(run.startedAt));
  if (!existsSync(file)) throw new Error(`auditGateEntries: no audit file at ${file}`);
  const text = readFileSync(file, 'utf8');
  const { header, events } = parseAuditStream(text);
  const documents = text.split('\n').filter((line) => line === '---').length;
  if (header === null || events.length !== documents - 1) {
    throw new Error(`auditGateEntries: ${file} has ${documents} documents but only ${events.length} events parse after its header`);
  }
  if (opts.step !== undefined) {
    const lastStart = events.map((e) => e.type).lastIndexOf('flow.started');
    return gateEntries(stepWindowEvents(events.slice(Math.max(lastStart, 0)), opts.step));
  }
  if (events.filter((e) => e.type === 'flow.started').length > 1) throw new Error(`auditGateEntries: ${file} holds more than one run (two Starts in one second)`);
  return gateEntries(events);
}

function gateEntries(events: AuditEvent[]): GateEntry[] {
  return events.flatMap((e) => (e.type === 'command' && e.source === 'gate' ? [{ cmd: e.cmd, exit: e.exit }] : []));
}
