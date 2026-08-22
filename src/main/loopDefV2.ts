// The §27 (v2) LoopDef parser + tier resolver. It shares no schema and no engine semantics with any other
// parser — only the engine-neutral primitives (isSafePathSegment, confinedPath). It NEVER throws: every
// failure mode returns a surfaced reason (AC 6). The declared version and the tier a def resolves from are
// the two things engine selection keys on.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  confinedRealPath,
  confinedRealPathResult,
  resolveJail,
  resolveOwnedDirJail,
} from './confinedPath';
import { isRecord } from './yamlRecord';
import { isSafePathSegment } from '../shared/pathSegment';
import { isErrno } from './errno';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopPaths';
import type {
  AppBootstrapLabelMutation,
  AppBootstrapWipePolicy,
} from '../shared/appBootstrap';

/** The schema version this app knows. Engine selection keys on the def namespace plus this marker, never
 *  on which parser happens not to throw. N2–N7 add only OPTIONAL elements under `v2`; a breaking change
 *  bumps it. A def declaring any other version fails to resolve (never partially parsed). */
export const LOOP_DEF_V2_VERSION = 'v2';

/** The trusted tier roots, injected so tests can point resolution at a temp root. `operator` is null when
 *  the user-config root is refused (a relative CLAUDE_CONFIG_DIR — see userConfig.ts); `appBundled` is the
 *  bundled default tree's root. A repo registry override is resolved separately before these tiers.
 *  `retired` is the retired engine's operator def dir (`userConfigLoopsDir()`), read for PRESENCE only
 *  when no surviving tier answers (AC 5) — its content is never read, parsed, moved or deleted; null when the
 *  root is refused. */
export interface LoopDefV2Tiers {
  operator: string | null;
  appBundled: string;
  retired: string | null;
}

/** One reviewer-catalog entry (§27.4/§27.8): a persona, its charter carried BY REFERENCE (§18.6 — never an
 *  inline body), and the tools it may use. Readable from the parsed def even though nothing consumes it in
 *  this slice. `charter` is the confined absolute path the reference resolved to. */
export interface ReviewerCatalogEntry {
  persona: string;
  charter: string;
  tools: string[];
}

/** One actor-boundary policy (§27.7): `clear`, or `compact` carrying the message naming what survives it. */
export interface BoundaryPolicy {
  boundary: string;
  mode: 'clear' | 'compact';
  message?: string;
}

/** One human-gate option's declared side-effects (§27.9/§27.13) — the app-implemented `gh` vocabulary,
 *  an open def-declared set. NOT the §27.8 executable capability: a program a def names is declared once,
 *  on the top-level `exec` field (`ExecSideEffect`), which `toGate` refuses to let a gate side-effect name —
 *  one surface, not scattered (CWE-829). Def tiers carry no trust distinction and the executable side-effect
 *  is unshipped; shipping it requires deciding trust afresh (v2.129). */
export interface GateSideEffect {
  kind: string;
  args: Record<string, unknown>;
}

export interface GateOptionDef {
  option: string;
  sideEffects: GateSideEffect[];
}

/** The framework-neutral completion mode a work turn declares (§28.4/§28.5.5) — which machine completion
 *  predicate gates it. A closed set recognized by exact string, single-sourced so the field type AND the
 *  parser's validation both derive from it (mirroring PHASE_OUTCOMES); it grows to green/refactor in S4/S5. */
export const WORK_COMPLETIONS = ['red'] as const;
export type WorkCompletion = (typeof WORK_COMPLETIONS)[number];
const WORK_COMPLETION_SET: ReadonlySet<string> = new Set(WORK_COMPLETIONS);
export function isWorkCompletion(value: string): value is WorkCompletion {
  return WORK_COMPLETION_SET.has(value);
}

/** The work recipe (§27.3): the prompt recipe reference (confined), the id of the artifact it produces, and —
 *  §28.4 — the optional completion mode (absent for the existing §27 loops). */
export interface WorkRecipe {
  recipe: string;
  artifact: string;
  completion?: WorkCompletion;
}

/** §27.10 */
export interface ArtifactBinding {
  id: string;
  path: string;
  rel: string;
}

/** §27.10 */
export type PickupLabelV2 = AppBootstrapLabelMutation;

/** §27.10 */
export type WipePolicy = AppBootstrapWipePolicy;

/** §27.10 */
export interface PickupExecutionV2 {
  initialStatus: string;
  branchTemplate: string;
  initialLabels: PickupLabelV2[];
}

/** §27.10 */
export interface PickupContractV2 extends PickupExecutionV2 {
  wipe: WipePolicy;
}

/** The prescribed round-report structure (§27.5). */
export interface ReportStructure {
  sections: string[];
}

/** The def-supplied executable side-effect (§27.8): a def MAY name a program to run. INERT in this slice —
 *  no execution surface runs one. Def tiers carry no trust distinction; shipping the executable side-effect
 *  requires deciding trust afresh (v2.129). */
export interface ExecSideEffect {
  program: string;
}

/** A fully-parsed §27 def. Every path-valued field (`work.recipe`, each `reviewers[].charter`,
 *  `consolidator`, each `inputs[]`/`outputs[]` path) is already confined to the boundary its role dictates;
 *  an escape is a resolution failure, so a parsed def carries no escaping path. */
export interface LoopDefV2 {
  version: string;
  name: string;
  work: WorkRecipe;
  reviewers: ReviewerCatalogEntry[];
  consolidator: string;
  boundaries: BoundaryPolicy[];
  report: ReportStructure;
  gate: GateOptionDef[];
  pickup: PickupContractV2 | null;
  inputs: ArtifactBinding[];
  outputs: ArtifactBinding[];
  exec: ExecSideEffect | null;
}

/** Resolution result: the parsed def plus the tier root it resolved from (read by the composition root and
 *  by AC 5's entry-seam migration trigger — a structural fact about where resolution stopped, not a trust
 *  label), or a human-readable reason surfaced in the UI (AC 6). */
export type LoopDefV2Result = { ok: true; def: LoopDefV2; tierRoot: string } | { ok: false; reason: string };

export interface LoopDefV2Context {
  tiers: LoopDefV2Tiers;
  repoDir: string;
}

const ALLOWED_TOP_KEYS = new Set([
  'version',
  'name',
  'work',
  'reviewers',
  'consolidator',
  'boundaries',
  'report',
  'gate',
  'pickup',
  'inputs',
  'outputs',
  'exec',
]);

const UNEXPANDED_SLOT = /\{[^}]*\}/;

class DefError extends Error {}
function fail(reason: string): never {
  throw new DefError(reason);
}

/** Confine a def-relative resource reference (a charter, a recipe) to the tier root it was read beside
 *  (§27.8/§18.6). Throws DefError on escape. */
function confineDefRelative(tierRoot: string, defDir: string, ref: string, what: string): string {
  if (ref.includes('\n')) fail(`${what} must be a path reference, not an inline body`);
  if (UNEXPANDED_SLOT.test(ref)) fail(`${what} reference carries an unexpanded slot: ${ref}`);
  const jail = resolveJail(tierRoot);
  if (jail === null) fail(`${what} tier root is unresolvable`);
  const confined = confinedRealPath(jail, path.resolve(defDir, ref));
  if (confined === null) fail(`${what} reference escapes the tier root: ${ref}`);
  return confined;
}

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** Confine an artifact/input/output path (§27.10) to the dedicated artifacts subtree of the per-repo loop
 *  area — disjoint from the engine's own loop state and round reports, so `../state.yaml` escapes onto the
 *  engine's own state and is rejected. Throws DefError. */
function confineArtifact(repoDir: string, pattern: string, what: string): { path: string; rel: string } {
  if (UNEXPANDED_SLOT.test(pattern)) fail(`${what} path carries an unexpanded slot: ${pattern}`);
  // The composed `rel` is interpolated into the agent-facing work prompt, where a control character would
  // break the line it is named on and leave the remainder standing as its own instruction (CWE-74).
  if (CONTROL_CHAR.test(pattern)) fail(`${what} path contains a control character`);
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  if (jail === null) fail(`${what} loop area is unresolvable`);
  const confined = confinedRealPath(jail, path.resolve(jail, pattern));
  if (confined === null) fail(`${what} path escapes the artifacts subtree: ${pattern}`);
  if (confined === jail) fail(`${what} path must name a file inside the artifacts subtree: ${pattern}`);
  const rel = [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, ...path.relative(jail, confined).split(path.sep)].join('/');
  // `rel` is composed from the POST-realpath location, whose segment names are repo working-tree content
  // rather than def content (§27.8) — a symlink to a name carrying a control character passes the check above.
  if (CONTROL_CHAR.test(rel)) fail(`${what} path resolves through a name containing a control character`);
  return { path: confined, rel };
}

function requireSegment(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isSafePathSegment(value)) fail(`${what} is not a single safe path segment: ${String(value)}`);
  return value;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

function requireNonBlankString(value: unknown, what: string): string {
  const text = requireString(value, what);
  if (text.trim().length === 0) fail(`${what} must not be blank`);
  return text;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

function toReviewers(raw: unknown, tierRoot: string, defDir: string): ReviewerCatalogEntry[] {
  if (!Array.isArray(raw)) fail('reviewers must be a list');
  return (raw as unknown[]).map((r) => {
    if (!isRecord(r)) fail('each reviewer must be a mapping');
    const rec = r as Record<string, unknown>;
    const persona = requireSegment(rec.persona, 'reviewer persona');
    const charter = confineDefRelative(tierRoot, defDir, requireString(rec.charter, 'reviewer charter'), 'charter');
    if (!Array.isArray(rec.tools) || !(rec.tools as unknown[]).every((t) => typeof t === 'string')) {
      fail(`reviewer ${persona} tools must be a list of strings`);
    }
    return { persona, charter, tools: rec.tools as string[] };
  });
}

function toBoundaries(raw: unknown): BoundaryPolicy[] {
  if (!Array.isArray(raw)) fail('boundaries must be a list');
  return (raw as unknown[]).map((b) => {
    if (!isRecord(b)) fail('each boundary must be a mapping');
    const rec = b as Record<string, unknown>;
    const boundary = requireString(rec.boundary, 'boundary name');
    if (rec.mode !== 'clear' && rec.mode !== 'compact') fail(`boundary ${boundary} mode must be clear or compact`);
    const mode = rec.mode as 'clear' | 'compact';
    if (mode === 'compact') return { boundary, mode, message: requireString(rec.message, `boundary ${boundary} compact message`) };
    return { boundary, mode };
  });
}

function toGate(raw: unknown): GateOptionDef[] {
  if (!Array.isArray(raw)) fail('gate must be a list');
  return (raw as unknown[]).map((g) => {
    if (!isRecord(g)) fail('each gate option must be a mapping');
    const rec = g as Record<string, unknown>;
    const option = requireString(rec.option, 'gate option');
    const rawSe = rec.side_effects ?? [];
    if (!Array.isArray(rawSe)) fail(`gate option ${option} side_effects must be a list`);
    const sideEffects = (rawSe as unknown[]).map((se) => {
      const seRec = requireRecord(se, `gate option ${option} side-effect`);
      const kind = requireString(seRec.kind, `gate option ${option} side-effect kind`);
      // The §27.8 executable capability is declared once, on the top-level `exec` field — never smuggled
      // through a gate side-effect, so the executable surface is single rather than scattered (CWE-829). Def
      // tiers carry no trust distinction (v2.129).
      if (kind === 'exec') fail(`gate option ${option} side-effect must not name kind: exec (declare a program on the top-level exec field)`);
      const { kind: _k, ...args } = seRec;
      return { kind, args };
    });
    return { option, sideEffects };
  });
}

function toArtifactBindings(raw: unknown, repoDir: string, what: string): ArtifactBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${what} must be a list`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((a) => {
    if (!isRecord(a)) fail(`each ${what} entry must be a mapping`);
    const rec = a as Record<string, unknown>;
    const id = requireSegment(rec.id, `${what} id`);
    // §27.10 persists carried ids and re-resolves them by id, so a duplicate is an ambiguous key: one
    // recorded id would select two bindings naming two different paths.
    if (seen.has(id)) fail(`${what} id is declared twice: ${id}`);
    seen.add(id);
    const { path: p, rel } = confineArtifact(repoDir, requireString(rec.path, `${what} ${id} path`), `${what} ${id}`);
    return { id, path: p, rel };
  });
}

function toWipePolicy(raw: unknown): WipePolicy {
  if (raw === undefined) return { mode: 'abort' };
  if (raw === 'abort') return { mode: 'abort' };
  if (raw === 'wipe-and-retry') return { mode: 'wipe-and-retry' };
  fail(`pickup on_conflict must be abort or wipe-and-retry: ${String(raw)}`);
}

function toPickupLabels(raw: unknown): PickupLabelV2[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail('pickup initial_labels must be a list');
  return (raw as unknown[]).map((l) => {
    const rec = requireRecord(l, 'pickup initial_labels entry');
    if (rec.action !== 'add' && rec.action !== 'remove') fail(`pickup label action must be add or remove: ${String(rec.action)}`);
    if (rec.target !== 'issue' && rec.target !== 'pr') fail(`pickup label target must be issue or pr: ${String(rec.target)}`);
    return { action: rec.action, target: rec.target, label: requireNonBlankString(rec.label, 'pickup label') };
  });
}

function toPickup(raw: unknown): PickupContractV2 | null {
  if (raw === undefined) return null;
  const pickup = requireRecord(raw, 'pickup');
  return {
    initialStatus: requireString(pickup.initial_status, 'pickup initial_status'),
    branchTemplate: requireString(pickup.branch_template, 'pickup branch_template'),
    initialLabels: toPickupLabels(pickup.initial_labels),
    wipe: toWipePolicy(pickup.on_conflict),
  };
}

function parse(body: string, tierRoot: string, defDir: string, name: string, repoDir: string): LoopDefV2 {
  let doc: unknown;
  try {
    doc = yaml.load(body);
  } catch (e) {
    fail(`malformed yaml: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(doc)) fail('def is not a mapping');
  const rec = doc as Record<string, unknown>;

  for (const key of Object.keys(rec)) {
    if (!ALLOWED_TOP_KEYS.has(key)) fail(`unknown key: ${key}`);
  }
  if (rec.version !== LOOP_DEF_V2_VERSION) fail(`unknown schema version: ${String(rec.version)} (expected ${LOOP_DEF_V2_VERSION})`);
  // `name` is resolver-assigned from the resolving path — def content cannot forge it. A declared `name` is
  // accepted only when it agrees, so the parsed def has one source of truth for its id.
  if (rec.name !== undefined && rec.name !== name) fail(`declared name ${String(rec.name)} disagrees with the resolved name ${name}`);

  const work = requireRecord(rec.work, 'work');
  const workRecipe = confineDefRelative(tierRoot, defDir, requireString(work.recipe, 'work recipe'), 'work recipe');
  const workArtifact = requireString(work.artifact, 'work artifact');
  let workCompletion: WorkCompletion | undefined;
  if (work.completion !== undefined) {
    const c = requireString(work.completion, 'work completion');
    if (!isWorkCompletion(c)) fail(`unknown work completion: ${c}`);
    workCompletion = c;
  }

  const cons = requireRecord(rec.consolidator, 'consolidator');
  const consolidator = confineDefRelative(tierRoot, defDir, requireString(cons.recipe, 'consolidator recipe'), 'consolidator recipe');

  const report = requireRecord(rec.report, 'report');
  const sections = report.sections;
  if (!Array.isArray(sections) || !(sections as unknown[]).every((s) => typeof s === 'string')) fail('report sections must be a list of strings');

  let exec: ExecSideEffect | null = null;
  if (rec.exec !== undefined && rec.exec !== null) {
    exec = { program: requireString(requireRecord(rec.exec, 'exec').program, 'exec program') };
  }

  const outputs = toArtifactBindings(rec.outputs, repoDir, 'output');
  // §28.5.5 — a declared completion mode validates a result FILE, so `work.artifact` MUST name a real output
  // binding (unlike a `commits`-producing turn, whose artifact legitimately resolves to none). Fail closed at
  // parse time: a `completion` def whose artifact does not resolve would otherwise reach the completion gate
  // with no result-file path to shape-validate — a false-pass on the done-signal alone (F1).
  if (workCompletion !== undefined && !outputs.some((o) => o.id === workArtifact)) {
    fail(`work.completion: ${workCompletion} requires work.artifact "${workArtifact}" to name an output binding`);
  }

  return {
    version: LOOP_DEF_V2_VERSION,
    name,
    work: {
      recipe: workRecipe,
      artifact: workArtifact,
      ...(workCompletion !== undefined ? { completion: workCompletion } : {}),
    },
    reviewers: toReviewers(rec.reviewers, tierRoot, defDir),
    consolidator,
    boundaries: toBoundaries(rec.boundaries),
    report: { sections: sections as string[] },
    gate: toGate(rec.gate),
    pickup: toPickup(rec.pickup),
    inputs: toArtifactBindings(rec.inputs, repoDir, 'input'),
    outputs,
    exec,
  };
}

/** Resolve a §27 loop NAME through a repo registry override, then the operator and app-bundled tiers (first
 *  EXISTING file wins). The loop name is held to a single safe segment BEFORE it is joined to any tier root.
 *  A found-but-malformed def surfaces its reason rather than falling through to a different tier. Each
 *  candidate carries the jail its own construction site resolved and a plain display name used only to
 *  compose failure messages — no tier carries a trust label (v2.129). */
interface DefCandidate {
  tierRoot: string;
  defDir: string;
  defPath: string;
  tierName: string;
  jail: string;
}

function repoCandidate(name: string, repoDir: string): DefCandidate | { reason: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoDir, '.agent-loop.yaml'), 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    return { reason: `cannot read repo loop registry: ${e instanceof Error ? e.message : String(e)}` };
  }
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return null;
  }
  if (!isRecord(doc) || !isRecord(doc.loops) || typeof doc.loops[name] !== 'string') return null;
  const root = path.resolve(repoDir);
  const target = path.resolve(root, doc.loops[name]);
  // The repo tier root is a jail sitting INSIDE untrusted content, where a link can be planted at the jail's
  // own final segment — resolveJail. A null here REFUSES with a reason (unlike a tier candidate, which falls
  // through to the next tier).
  const jail = resolveJail(root);
  if (jail === null || (target !== root && !target.startsWith(root + path.sep))) {
    return { reason: `repo loop override for ${name} escapes the repository` };
  }
  const defPath = confinedRealPath(jail, target);
  if (defPath === null) return { reason: `repo loop override for ${name} is unresolvable` };
  return { tierRoot: root, defDir: path.dirname(defPath), defPath, tierName: 'repo', jail };
}

export function resolveLoopDefV2(name: string, ctx: LoopDefV2Context): LoopDefV2Result {
  if (!isSafePathSegment(name)) return { ok: false, reason: `loop name is not a single safe path segment: ${name}` };
  const candidates: DefCandidate[] = [];
  const repo = repoCandidate(name, ctx.repoDir);
  if (repo && 'reason' in repo) return { ok: false, reason: repo.reason };
  if (repo) candidates.push(repo);
  // The operator and app-bundled tier roots are ground the app derives itself and either may be absent (the
  // operator's on a first run) — resolveOwnedDirJail. A tier whose jail is unresolvable FALLS THROUGH to the
  // next tier (an absent ~/.claude must not turn every loop step unresolvable), so a null jail is simply not
  // pushed as a candidate.
  if (ctx.tiers.operator !== null) {
    const jail = resolveOwnedDirJail(ctx.tiers.operator);
    if (jail !== null) {
      const defDir = path.join(ctx.tiers.operator, name);
      candidates.push({ tierRoot: ctx.tiers.operator, defDir, defPath: path.join(defDir, `${name}.yaml`), tierName: 'operator', jail });
    }
  }
  const appJail = resolveOwnedDirJail(ctx.tiers.appBundled);
  if (appJail !== null) {
    const appDefDir = path.join(ctx.tiers.appBundled, name);
    candidates.push({ tierRoot: ctx.tiers.appBundled, defDir: appDefDir, defPath: path.join(appDefDir, `${name}.yaml`), tierName: 'app-bundled', jail: appJail });
  }

  for (const { tierRoot, defDir, defPath, tierName, jail } of candidates) {
    const confinedDefPath = confinedRealPathResult(jail, defPath);
    if (!confinedDefPath.ok) {
      return {
        ok: false,
        reason:
          confinedDefPath.cause === 'escapes'
            ? `def ${name} in the ${tierName} tier escapes its tier root`
            : `def ${name} in the ${tierName} tier is unresolvable`,
      };
    }
    let body: string;
    try {
      body = readFileSync(confinedDefPath.path, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) continue;
      return { ok: false, reason: `cannot read def ${name}: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      return { ok: true, def: parse(body, tierRoot, defDir, name, ctx.repoDir), tierRoot };
    } catch (e) {
      if (e instanceof DefError) return { ok: false, reason: e.message };
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  const bareReason = `no §27 def named ${name} in any tier`;
  // AC 5 (§B.6): with no surviving tier answering, a retired-schema def of the same name — if PRESENT —
  // turns the bare miss into a reason naming why it stopped resolving, on the same per-step loop-error path
  // AC 4 uses. PRESENCE only: the retired def's content is never read, parsed, moved or deleted. The retired
  // root is the operator's own ground and may be absent on a first run, so it jails through resolveOwnedDirJail
  // (a null jail — no ~/.claude — is simply "no retired def", the bare reason); the reason-surfacing branch
  // uses confinedRealPathResult so an unresolvable entry is never reported as an escape (§B.6).
  if (ctx.tiers.retired !== null) {
    const retiredJail = resolveOwnedDirJail(ctx.tiers.retired);
    if (retiredJail !== null) {
      // The retired-schema def is `<retired>/<name>/<name>.yaml` (the retired engine's own path convention) —
      // a bare directory of that name is not a def. Confine FIRST (realpathBounded appends an absent tail, so
      // `.ok` alone means "bounded", not "exists"), then test existence of the FILE on the bounded path —
      // presence, no content read.
      const probe = confinedRealPathResult(retiredJail, path.join(ctx.tiers.retired, name, `${name}.yaml`));
      if (probe.ok && existsSync(probe.path)) {
        return {
          ok: false,
          reason: `${bareReason}; a retired-schema def named ${name} is present in your config and is no longer read — re-create it under loops-v2`,
        };
      }
    }
  }
  return { ok: false, reason: bareReason };
}
