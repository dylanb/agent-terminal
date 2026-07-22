// The §27 (v2) LoopDef parser + tier resolver. Independent of the §26 parser (loopDef.ts): it shares no
// schema and no engine semantics — only the engine-neutral primitives (isSafePathSegment, confinedPath).
// It NEVER throws: every failure mode returns a surfaced reason (AC 6). The declared version and the tier
// a def resolves from are the two things engine selection keys on; a def's origin is assigned by the
// resolver from its tier, never read from def content (a content-declared `origin` is an unknown key).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isRecord } from './yamlRecord';
import { isSafePathSegment } from '../shared/pathSegment';
import { isErrno } from './errno';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopState';

/** The schema version this app knows. Engine selection keys on the def namespace plus this marker, never
 *  on which parser happens not to throw. N2–N7 add only OPTIONAL elements under `v2`; a breaking change
 *  bumps it. A def declaring any other version fails to resolve (never partially parsed). */
export const LOOP_DEF_V2_VERSION = 'v2';

/** The tier a def resolved from, assigned by the resolver — NEVER a schema-authorable field. `operator` is
 *  the user's own config tier (trusted); `app-bundled` is the default shipped with the app (trusted). The
 *  repo tier (untrusted) is added by sub-ticket 2. Capability slices key their privilege on this label, so
 *  no def content can forge it. */
export type LoopDefV2Origin = 'operator' | 'app-bundled';

/** The tier roots, injected so tests can point resolution at a temp root. `operator` is null when the
 *  user-config root is refused (a relative CLAUDE_CONFIG_DIR — see userConfig.ts); `appBundled` is the
 *  bundled default tree's root. First hit wins, operator before app-bundled. */
export interface LoopDefV2Tiers {
  operator: string | null;
  appBundled: string;
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
 *  on the top-level `exec` field (`ExecSideEffect`), which `toGate` refuses to let a gate side-effect name
 *  so there is a single origin-gated executable surface for sub-ticket 2 to guard (CWE-829). */
export interface GateSideEffect {
  kind: string;
  args: Record<string, unknown>;
}

export interface GateOptionDef {
  option: string;
  sideEffects: GateSideEffect[];
}

/** The work recipe (§27.3): the prompt recipe reference (confined) and the id of the artifact it produces. */
export interface WorkRecipe {
  recipe: string;
  artifact: string;
}

/** An input the loop consumes or an output it produces (§27.10). `id` is a safe segment; `path` is the
 *  confined absolute path inside the dedicated artifacts subtree of the per-repo loop area, and `rel` is the
 *  same location repo-relative, composed here from the segments the confinement itself used. */
export interface ArtifactBinding {
  id: string;
  path: string;
  rel: string;
}

/** The bootstrap (pickup) contract (§27.10) — declared here; nothing acts on it in this slice. */
export interface PickupContractV2 {
  initialStatus: string;
  branchTemplate: string;
}

/** The prescribed round-report structure (§27.5). */
export interface ReportStructure {
  sections: string[];
}

/** The def-supplied executable side-effect (§27.8): a def MAY name a program to run. INERT in this slice —
 *  no untrusted tier authors one and no execution surface runs one. Origin gates it (sub-ticket 2). */
export interface ExecSideEffect {
  program: string;
}

/** A fully-parsed §27 def. Every path-valued field (`work.recipe`, each `reviewers[].charter`,
 *  `consolidator`, each `inputs[]`/`outputs[]` path) is already confined to the boundary its role dictates;
 *  an escape is a resolution failure, so a parsed def carries no escaping path. `origin` is resolver-assigned. */
export interface LoopDefV2 {
  version: string;
  name: string;
  origin: LoopDefV2Origin;
  work: WorkRecipe;
  reviewers: ReviewerCatalogEntry[];
  consolidator: string;
  boundaries: BoundaryPolicy[];
  report: ReportStructure;
  gate: GateOptionDef[];
  pickup: PickupContractV2;
  inputs: ArtifactBinding[];
  outputs: ArtifactBinding[];
  exec: ExecSideEffect | null;
}

/** Resolution result: the parsed def, or a human-readable reason surfaced in the UI (AC 6). */
export type LoopDefV2Result = { ok: true; def: LoopDefV2 } | { ok: false; reason: string };

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

/** Confine an artifact/input/output path (§27.10) to the dedicated artifacts subtree of the per-repo loop
 *  area — disjoint from the engine's own loop state and round reports, so `../state.yaml` escapes onto the
 *  engine's own state and is rejected. Throws DefError. */
function confineArtifact(repoDir: string, pattern: string, what: string): { path: string; rel: string } {
  if (UNEXPANDED_SLOT.test(pattern)) fail(`${what} path carries an unexpanded slot: ${pattern}`);
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  if (jail === null) fail(`${what} loop area is unresolvable`);
  const confined = confinedRealPath(jail, path.resolve(jail, pattern));
  if (confined === null) fail(`${what} path escapes the artifacts subtree: ${pattern}`);
  const rel = [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, ...path.relative(jail, confined).split(path.sep)].join('/');
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
      // through a gate side-effect, so origin-gating (sub-ticket 2) has a single surface (CWE-829).
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
  return (raw as unknown[]).map((a) => {
    if (!isRecord(a)) fail(`each ${what} entry must be a mapping`);
    const rec = a as Record<string, unknown>;
    const id = requireSegment(rec.id, `${what} id`);
    const { path: p, rel } = confineArtifact(repoDir, requireString(rec.path, `${what} ${id} path`), `${what} ${id}`);
    return { id, path: p, rel };
  });
}

function parse(body: string, tierRoot: string, defDir: string, name: string, origin: LoopDefV2Origin, repoDir: string): LoopDefV2 {
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
  // `name` is resolver-assigned from the resolving path — like `origin`, def content cannot forge it. A
  // declared `name` is accepted only when it agrees, so the parsed def has one source of truth for its id.
  if (rec.name !== undefined && rec.name !== name) fail(`declared name ${String(rec.name)} disagrees with the resolved name ${name}`);

  const work = requireRecord(rec.work, 'work');
  const workRecipe = confineDefRelative(tierRoot, defDir, requireString(work.recipe, 'work recipe'), 'work recipe');
  const workArtifact = requireString(work.artifact, 'work artifact');

  const cons = requireRecord(rec.consolidator, 'consolidator');
  const consolidator = confineDefRelative(tierRoot, defDir, requireString(cons.recipe, 'consolidator recipe'), 'consolidator recipe');

  const report = requireRecord(rec.report, 'report');
  const sections = report.sections;
  if (!Array.isArray(sections) || !(sections as unknown[]).every((s) => typeof s === 'string')) fail('report sections must be a list of strings');

  const pickup = requireRecord(rec.pickup, 'pickup');

  let exec: ExecSideEffect | null = null;
  if (rec.exec !== undefined && rec.exec !== null) {
    exec = { program: requireString(requireRecord(rec.exec, 'exec').program, 'exec program') };
  }

  return {
    version: LOOP_DEF_V2_VERSION,
    name,
    origin,
    work: { recipe: workRecipe, artifact: workArtifact },
    reviewers: toReviewers(rec.reviewers, tierRoot, defDir),
    consolidator,
    boundaries: toBoundaries(rec.boundaries),
    report: { sections: sections as string[] },
    gate: toGate(rec.gate),
    pickup: {
      initialStatus: requireString(pickup.initial_status, 'pickup initial_status'),
      branchTemplate: requireString(pickup.branch_template, 'pickup branch_template'),
    },
    inputs: toArtifactBindings(rec.inputs, repoDir, 'input'),
    outputs: toArtifactBindings(rec.outputs, repoDir, 'output'),
    exec,
  };
}

/** Resolve a §27 loop NAME to a parsed def across the injected tiers (operator, then app-bundled; first
 *  EXISTING file wins). The loop name is held to a single safe segment BEFORE it is joined to any tier root.
 *  A found-but-malformed def surfaces its reason rather than falling through to a different tier. */
export function resolveLoopDefV2(name: string, ctx: LoopDefV2Context): LoopDefV2Result {
  if (!isSafePathSegment(name)) return { ok: false, reason: `loop name is not a single safe path segment: ${name}` };
  const candidates: Array<{ tierRoot: string; origin: LoopDefV2Origin }> = [];
  if (ctx.tiers.operator !== null) candidates.push({ tierRoot: ctx.tiers.operator, origin: 'operator' });
  candidates.push({ tierRoot: ctx.tiers.appBundled, origin: 'app-bundled' });

  for (const { tierRoot, origin } of candidates) {
    const defDir = path.join(tierRoot, name);
    const defPath = path.join(defDir, `${name}.yaml`);
    let body: string;
    try {
      body = readFileSync(defPath, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) continue;
      return { ok: false, reason: `cannot read def ${name}: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      return { ok: true, def: parse(body, tierRoot, defDir, name, origin, ctx.repoDir) };
    } catch (e) {
      if (e instanceof DefError) return { ok: false, reason: e.message };
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, reason: `no §27 def named ${name} in any tier` };
}
