// §23.5 — `agent-terminal --validate-flow <dir>`: the flow folder is located in its tier and loaded through the
// app's own catalog resolver and flow loaders, its loops are resolved the way a run in that tier resolves them,
// and the first problem found is printed on one line. It only reads.

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { flowCatalogDir, flowDefinitionFile, flowHomeDir, loadFlowDefinition, loadUntrustedFlowDefinition, stepTemplateRef, type FlowDefinition, type FlowLoad } from './flow';
import { FLOW_DEF_FILE } from './flowHome';
import { probeTier, resolveCatalogEntry } from './flowCatalog';
import { catalogRefusalReason, UNSAFE_NAME_REASON } from './resolveRunDefinition';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from './exampleAssets';
import { realpathBounded, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { CLI_COMMAND_NAME, VALIDATE_FLOW_FLAG } from './cliShim';
import { errMsg, isErrno } from './errno';
import { resolveLoopDefV2, type LoopDefV2, type LoopDefV2Context, type LoopDefV2Tiers } from './loopDefV2';
import { todoTemplateResolves, todoTemplatesDir } from './todoTemplate';
import { isReadableRegularFile } from './regularFile';
import { isSafeCatalogId } from '../shared/pathSegment';
import { stripDisplayControlChars } from '../shared/controlChars';
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

/** The file a problem is about, and what is wrong with it. */
interface Problem {
  file: string;
  text: string;
}

/** How a run of the flow resolves its loops: the context `resolveLoopDefV2` gets, before the flow's name is added. */
type LoopScope = Omit<LoopDefV2Context, 'flow'>;

/** A located flow folder: the file its flow loader read, that loader's result, and its tier's loop scope. */
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
  const refused = folderRefusal(folder);
  if (refused !== null) return { file: folder, text: refused };
  const located = locate(folder, deps);
  if (!located.ok) return { file: folder, text: located.reason };
  if (!located.load.ok) return { file: located.flowFile, text: located.load.error };
  return stepProblem(located.load.definition, located.load.flowDir, located.flowFile, { ...located.loops, flow: located.load.definition.name, refuseSpecialFiles: true });
}

/** The first step, in flow order, whose binding, todo template or loop a run would fail on. */
function stepProblem(definition: FlowDefinition, flowDir: string, flowFile: string, loops: LoopDefV2Context): Problem | null {
  const templatesDir = todoTemplatesDir(flowDir);
  for (const step of definition.steps) {
    if (step.loop !== undefined && bindsNoSurvivingEngine(step.loopNamespace ?? DEFAULT_LOOP_NAMESPACE)) {
      return { file: flowFile, text: `step ${step.id}: ${MARKED_BINDING_REASON}` };
    }
    const templateRef = stepTemplateRef(step);
    if (templateRef !== null && !todoTemplateResolves(templatesDir, templateRef)) {
      return { file: flowFile, text: `step ${step.id}: todo template ${templateRef} does not resolve in ${templatesDir}` };
    }
    if (step.loop === undefined) continue;
    const resolved = resolveLoopDefV2(step.loop, loops);
    const defFile = resolved.defFile ?? flowFile;
    if (!resolved.ok) return { file: defFile, text: resolved.reason };
    const missing = unreadableReference(resolved.def, path.dirname(defFile));
    if (missing !== null) return { file: defFile, text: missing };
  }
  return null;
}

/** The first file reference of `def` that names no readable regular file. It is checked with `stat`, never
 *  opened, so a named pipe cannot block it. */
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

/** The jail at `dir` with only `anchor` resolved: the segments below it stay unresolved, so a linked one cannot become the jail. */
const jailBelow = (anchor: string, dir: string): string | null => resolveJail(anchor, ...path.relative(anchor, dir).split(path.sep));

/** The tier comes from where the folder sits; only its anchor (the repository, A or the bundle root) is
 *  resolved, so the app's own resolvers judge every segment below it, links included (CWE-59). */
function locate(folder: string, deps: ValidateFlowDeps): Located {
  const { appHome } = deps;
  const homeAnchor = path.dirname(folder);
  const entryAnchor = path.dirname(path.dirname(path.dirname(folder)));
  const id = path.basename(folder);
  if (flowHomeDir(homeAnchor) === folder) {
    return isAppHome(homeAnchor, appHome)
      ? locateFlowHome(appHome, globalScope(folder, deps.loopTiers))
      : locateFlowHome(homeAnchor, { tiers: deps.loopTiers, repoDir: homeAnchor });
  }
  const catalogEntry = flowCatalogDir(entryAnchor) === path.dirname(folder);
  const bundledEntry = resolveExampleFlowsDir({ packaged: false, appPath: entryAnchor }) === path.dirname(folder);
  if (!catalogEntry && !bundledEntry) return { ok: false, reason: notInTierReason(appHome) };
  if (!isSafeCatalogId(id)) return { ok: false, reason: `its name ${UNSAFE_NAME_REASON}` };
  return catalogEntry ? locateCatalogEntry(entryAnchor, id, deps) : locateBundledEntry(entryAnchor, id);
}

function isAppHome(anchor: string, appHome: string): boolean {
  const real = resolveJail(anchor);
  return real !== null && real === resolveOwnedDirJail(appHome);
}

/** No repository override registry applies to a global flow, even when A is a repository, so none is read and
 *  the flow's own folder anchors the resolver's artifact paths. */
const globalScope = (folder: string, tiers: LoopDefV2Tiers): LoopScope => ({ tiers, repoDir: folder, skipRepoOverrides: true });

function locateFlowHome(root: string, loops: LoopScope): Located {
  const file = flowDefinitionFile(root);
  return { ok: true, flowFile: realpathBounded(file) ?? file, load: loadFlowDefinition(root), loops };
}

function locateCatalogEntry(anchor: string, id: string, deps: ValidateFlowDeps): Located {
  const tier = isAppHome(anchor, deps.appHome) ? 'global' : 'repo';
  const entry = resolveCatalogEntry({ worktreeDir: anchor, globalRoot: deps.appHome }, id, tier);
  if (!entry.ok) return { ok: false, reason: `this catalog entry ${catalogRefusalReason(entry.cause)}` };
  const loops = tier === 'global' ? globalScope(entry.flowDir, deps.loopTiers) : { tiers: deps.loopTiers, repoDir: anchor };
  return loadEntry(entry.flowDir, loops);
}

/** A bundle root is repository content when it is a source tree, so it is confined as untrusted ground. */
function locateBundledEntry(root: string, id: string): Located {
  const bundle = { packaged: false, appPath: root } as const;
  const flowsDir = resolveExampleFlowsDir(bundle);
  const probe = probeTier(jailBelow(root, flowsDir), id, path.join(flowsDir, id, FLOW_DEF_FILE));
  if (probe.kind !== 'entry') {
    return { ok: false, reason: `this bundled flow ${catalogRefusalReason(probe.kind === 'refused' ? probe.cause : 'unknown')}` };
  }
  const loopsDir = resolveExampleLoopsV2Dir(bundle);
  const loopsJail = jailBelow(root, loopsDir);
  if (loopsJail === null || realpathBounded(loopsJail) !== loopsJail || !isDirectory(loopsJail)) {
    return { ok: false, reason: `its bundle has no loop tree inside it at ${loopsDir}` };
  }
  return loadEntry(probe.flowDir, { tiers: { operator: null, appBundled: loopsJail, retired: null }, repoDir: probe.flowDir, skipRepoOverrides: true });
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
