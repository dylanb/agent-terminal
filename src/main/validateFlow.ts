import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { flowCatalogDir, flowCatalogRoot, flowDefinitionFile, loadFlowDefinition, loadUntrustedFlowDefinition, stepTemplateRef, type FlowDefinition, type FlowLoad } from './flow';
import { FLOW_DEF_FILE, flowHomeDir, flowHomeRoot } from './flowHome';
import { resolveBundledEntry, resolveCatalogEntry } from './flowCatalog';
import { catalogRefusalReason, UNSAFE_NAME_REASON } from './resolveRunDefinition';
import { exampleFlowsBundleRoot, resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from './exampleAssets';
import { realpathBounded, resolveJail, resolveJailBelow, resolveOwnedDirJail } from './confinedPath';
import { CLI_COMMAND_NAME, VALIDATE_FLOW_FLAG } from './cliShim';
import { errMsg, isErrno } from './errno';
import { resolveLoopDefV2, type LoopDefV2, type LoopDefV2Lookup, type LoopDefV2Tiers } from './loopDefV2';
import { loadTodoTemplateFile, todoTemplatesDir } from './todoTemplate';
import { isReadableRegularFile } from './regularFile';
import { isSafeCatalogId } from '../shared/pathSegment';
import { stripDisplayControlChars } from '../shared/controlChars';
import { countSourceRefusal } from './repeatSourceCheck';
import { DEFAULT_LOOP_NAMESPACE, MARKED_BINDING_REASON, bindsNoSurvivingEngine } from '../shared/loopNamespace';

export interface ValidateFlowDeps {
  /** The caller's working directory, which a relative operand resolves against. It throws when that directory
   *  no longer exists, so it is read only for a relative operand. */
  cwd: () => string;
  /** The app-state home A, whose flow home is the global tier. */
  appHome: string;
  /** The loop tiers the app hands a run of a repository or global flow. */
  loopTiers: LoopDefV2Tiers;
}

export interface ValidateFlowResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface Problem {
  file: string;
  text: string;
}

type LoopScope = Omit<LoopDefV2Lookup, 'flow'>;

type Located = { ok: true; flowFile: string; load: FlowLoad; loops: LoopScope } | { ok: false; reason: string };

const oneLine = (file: string, text: string): string => `${stripDisplayControlChars(file)}: ${stripDisplayControlChars(text)}\n`;

export function runValidateFlow(operands: readonly string[], deps: ValidateFlowDeps): ValidateFlowResult {
  if (operands.length !== 1) {
    return { exitCode: 2, stdout: '', stderr: `usage: ${CLI_COMMAND_NAME} ${VALIDATE_FLOW_FLAG} <flow folder>\n` };
  }
  const operand = operands[0];
  let folder = operand;
  let problem: Problem | null;
  try {
    folder = path.isAbsolute(operand) ? path.resolve(operand) : path.resolve(deps.cwd(), operand);
    problem = validate(folder, deps);
  } catch (e) {
    problem = { file: folder, text: `the check could not finish: ${errMsg(e)}` };
  }
  if (problem === null) return { exitCode: 0, stdout: `OK: ${stripDisplayControlChars(folder)} is a valid flow\n`, stderr: '' };
  return { exitCode: 1, stdout: oneLine(problem.file, problem.text), stderr: '' };
}

function validate(folder: string, deps: ValidateFlowDeps): Problem | null {
  const selected = selectFlowFolder(folder, deps);
  return selected.ok ? null : selected.problem;
}

export function selectFlowFolder(folder: string, deps: ValidateFlowDeps):
  | { ok: true; definition: FlowDefinition; flowDir: string; loops: LoopDefV2Lookup }
  | { ok: false; problem: Problem } {
  const refused = folderRefusal(folder);
  if (refused !== null) return { ok: false, problem: { file: folder, text: refused } };
  const located = locate(folder, deps);
  if (!located.ok) return { ok: false, problem: { file: folder, text: located.reason } };
  if (!located.load.ok) return { ok: false, problem: { file: located.flowFile, text: located.load.error } };
  const loops = { ...located.loops, flow: located.load.definition.name };
  const problem = stepProblem(located.load.definition, located.load.flowDir, located.flowFile, loops);
  return problem === null
    ? { ok: true, definition: located.load.definition, flowDir: located.load.flowDir, loops }
    : { ok: false, problem };
}

function stepProblem(definition: FlowDefinition, flowDir: string, flowFile: string, loops: LoopDefV2Lookup): Problem | null {
  const templatesDir = todoTemplatesDir(flowDir);
  const outputIds = new Map<string, readonly string[]>();
  for (const step of definition.steps) {
    if (step.loop !== undefined && bindsNoSurvivingEngine(step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE)) {
      return { file: flowFile, text: `step ${step.id}: ${MARKED_BINDING_REASON}` };
    }
    const templateRef = stepTemplateRef(step);
    if (templateRef !== null && loadTodoTemplateFile(templatesDir, templateRef) === null) {
      return { file: flowFile, text: `step ${step.id}: todo template ${templateRef} does not resolve in ${templatesDir}` };
    }
    if (step.loop === undefined) continue;
    const resolved = resolveLoopDefV2(step.loop, loops);
    if (!resolved.ok) return { file: resolved.defFile ?? flowFile, text: resolved.reason };
    const missing = unreadableReference(resolved.def, path.dirname(resolved.defFile));
    if (missing !== null) return { file: resolved.defFile, text: missing };
    outputIds.set(step.id, resolved.def.outputs.map((o) => o.id));
  }
  const refusal = countSourceRefusal(definition, (step) => outputIds.get(step.id) ?? null);
  return refusal === null ? null : { file: flowFile, text: refusal };
}

/** The first file reference of `def` that names no readable regular file. */
function unreadableReference(def: LoopDefV2, defDir: string): string | null {
  const refs: { what: string; file: string }[] = [
    ...(def.brief === undefined ? [] : [{ what: 'brief', file: def.brief }]),
    { what: 'work recipe', file: def.work.recipe },
    ...(def.rounds.kind === 'engine' ? [{ what: 'consolidator recipe', file: def.rounds.consolidator }] : []),
    ...def.reviewers.map((r) => ({ what: `reviewer ${r.persona} charter`, file: r.charter })),
  ];
  for (const { what, file } of refs) {
    if (!isReadableRegularFile(file)) return `${what} ${path.relative(defDir, file)} is not a readable file`;
  }
  return null;
}

function folderRefusal(folder: string): string | null {
  try {
    if (!statSync(folder).isDirectory()) return 'is not a directory';
    accessSync(folder, constants.R_OK | constants.X_OK);
  } catch (e) {
    return `cannot be opened: ${errMsg(e)}`;
  }
  try {
    if (!statSync(path.join(folder, FLOW_DEF_FILE)).isFile()) return `its ${FLOW_DEF_FILE} is not a regular file`;
  } catch (e) {
    return isErrno(e, 'ENOENT') ? `holds no ${FLOW_DEF_FILE}` : `cannot open its ${FLOW_DEF_FILE}: ${errMsg(e)}`;
  }
  return null;
}

/** The tier comes from where the folder sits; only its anchor (the repository, A or the bundle root) is
 *  resolved, so the app's own resolvers judge every segment below it, links included (CWE-59). */
function locate(folder: string, deps: ValidateFlowDeps): Located {
  const { appHome } = deps;
  const homeRoot = flowHomeRoot(folder);
  if (homeRoot !== null) {
    return isAppHome(homeRoot, appHome)
      ? locateFlowHome(appHome, globalScope(deps.loopTiers))
      : locateFlowHome(homeRoot, { tiers: deps.loopTiers, repoDir: homeRoot });
  }
  const entry = catalogOf(path.dirname(folder));
  if (entry === null) return { ok: false, reason: notInTierReason(appHome) };
  const id = path.basename(folder);
  if (!isSafeCatalogId(id)) return { ok: false, reason: `its name ${UNSAFE_NAME_REASON}` };
  switch (entry.kind) {
    case 'catalog':
      return locateCatalogEntry(entry.root, id, deps);
    case 'bundled':
      return locateBundledEntry(entry.root, id);
    default:
      return entry.kind satisfies never;
  }
}

function catalogOf(dir: string): { kind: 'catalog' | 'bundled'; root: string } | null {
  const catalogRoot = flowCatalogRoot(dir);
  if (catalogRoot !== null) return { kind: 'catalog', root: catalogRoot };
  const bundleRoot = exampleFlowsBundleRoot(dir);
  return bundleRoot === null ? null : { kind: 'bundled', root: bundleRoot };
}

function isAppHome(anchor: string, appHome: string): boolean {
  const real = resolveJail(anchor);
  return real !== null && real === resolveOwnedDirJail(appHome);
}

/** A global flow is checked for no repository, even when A is one. */
const globalScope = (tiers: LoopDefV2Tiers): LoopScope => ({ tiers, repoDir: null });

function locateFlowHome(root: string, loops: LoopScope): Located {
  const file = flowDefinitionFile(root);
  return { ok: true, flowFile: realpathBounded(file) ?? file, load: loadFlowDefinition(root), loops };
}

function locateCatalogEntry(anchor: string, id: string, deps: ValidateFlowDeps): Located {
  const tier = isAppHome(anchor, deps.appHome) ? 'global' : 'repo';
  const entry = resolveCatalogEntry({ worktreeDir: anchor, globalRoot: deps.appHome }, id, tier);
  if (!entry.ok) return { ok: false, reason: `this catalog entry ${catalogRefusalReason(entry.cause)}` };
  const loops = tier === 'global' ? globalScope(deps.loopTiers) : { tiers: deps.loopTiers, repoDir: anchor };
  return loadEntry(entry.flowDir, loops);
}

function locateBundledEntry(root: string, id: string): Located {
  const entry = resolveBundledEntry(root, id);
  if (!entry.ok) return { ok: false, reason: `this bundled flow ${catalogRefusalReason(entry.cause)}` };
  const loopsDir = resolveExampleLoopsV2Dir({ packaged: false, appPath: root });
  const loopsJail = resolveJailBelow(root, loopsDir);
  if (loopsJail === null || realpathBounded(loopsJail) !== loopsJail || !isDirectory(loopsJail)) {
    return { ok: false, reason: `its bundle has no loop tree inside it at ${loopsDir}` };
  }
  return loadEntry(entry.flowDir, { tiers: { operator: null, appBundled: loopsJail, retired: null }, repoDir: null });
}

function loadEntry(flowDir: string, loops: LoopScope): Located {
  const file = path.join(flowDir, FLOW_DEF_FILE);
  return { ok: true, flowFile: file, load: loadUntrustedFlowDefinition(file), loops };
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function notInTierReason(appHome: string): string {
  const entry = (dir: string): string => path.join(dir, '<id>');
  const tiers = [
    flowHomeDir(appHome),
    entry(flowCatalogDir(appHome)),
    flowHomeDir('<repo>'),
    entry(flowCatalogDir('<repo>')),
    entry(resolveExampleFlowsDir({ packaged: false, appPath: '<X>' })),
  ];
  return `is in no flow tier; a flow folder is one of ${tiers.join(', ')}`;
}
