// §23.5 — `agent-terminal --validate-flow <dir>`: the flow folder is located in its tier and loaded through the
// app's own catalog resolver and flow loaders, and the first problem they report is printed on one line. It
// only reads.

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { flowCatalogDir, flowDefinitionFile, flowHomeDir, loadFlowDefinition, loadUntrustedFlowDefinition, type FlowLoad } from './flow';
import { FLOW_DEF_FILE } from './flowHome';
import { probeTier, resolveCatalogEntry } from './flowCatalog';
import { catalogRefusalReason, UNSAFE_NAME_REASON } from './resolveRunDefinition';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from './exampleAssets';
import { realpathBounded, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { CLI_COMMAND_NAME, VALIDATE_FLOW_FLAG } from './cliShim';
import { errMsg, isErrno } from './errno';
import { isSafeCatalogId } from '../shared/pathSegment';
import { stripDisplayControlChars } from '../shared/controlChars';

export interface ValidateFlowDeps {
  /** The caller's working directory, which a relative operand resolves against. It throws when that directory
   *  no longer exists, so it is read only for a relative operand. */
  cwd: () => string;
  /** The app-state home A, whose flow home is the global tier. */
  appHome: string;
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

/** A located flow folder: the file its flow loader read, and that loader's result. */
type Located = { ok: true; flowFile: string; load: FlowLoad } | { ok: false; reason: string };

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
    problem = validate(folder, deps.appHome);
  } catch (e) {
    problem = { file: folder, text: `the check could not finish: ${errMsg(e)}` };
  }
  if (problem === null) return { exitCode: 0, stdout: `OK: ${stripDisplayControlChars(folder)} is a valid flow\n`, stderr: '' };
  return { exitCode: 1, stdout: oneLine(problem.file, problem.text), stderr: '' };
}

function validate(folder: string, appHome: string): Problem | null {
  const refused = folderRefusal(folder);
  if (refused !== null) return { file: folder, text: refused };
  const located = locate(folder, appHome);
  if (!located.ok) return { file: folder, text: located.reason };
  if (!located.load.ok) return { file: located.flowFile, text: located.load.error };
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
    statSync(path.join(folder, FLOW_DEF_FILE));
  } catch (e) {
    return isErrno(e, 'ENOENT') ? `holds no ${FLOW_DEF_FILE}` : `cannot open its ${FLOW_DEF_FILE}: ${errMsg(e)}`;
  }
  return null;
}

/** The jail at `dir` with only `anchor` resolved: the segments below it stay unresolved, so a linked one cannot become the jail. */
const jailBelow = (anchor: string, dir: string): string | null => resolveJail(anchor, ...path.relative(anchor, dir).split(path.sep));

/** The tier comes from where the folder sits; only its anchor (the repository, A or the bundle root) is
 *  resolved, so the app's own resolvers judge every segment below it, links included (CWE-59). */
function locate(folder: string, appHome: string): Located {
  const homeAnchor = path.dirname(folder);
  const entryAnchor = path.dirname(path.dirname(path.dirname(folder)));
  const id = path.basename(folder);
  if (flowHomeDir(homeAnchor) === folder) return locateFlowHome(isAppHome(homeAnchor, appHome) ? appHome : homeAnchor);
  const catalogEntry = flowCatalogDir(entryAnchor) === path.dirname(folder);
  const bundledEntry = resolveExampleFlowsDir({ packaged: false, appPath: entryAnchor }) === path.dirname(folder);
  if (!catalogEntry && !bundledEntry) return { ok: false, reason: notInTierReason(appHome) };
  if (!isSafeCatalogId(id)) return { ok: false, reason: `its name ${UNSAFE_NAME_REASON}` };
  return catalogEntry ? locateCatalogEntry(entryAnchor, id, appHome) : locateBundledEntry(entryAnchor, id);
}

function isAppHome(anchor: string, appHome: string): boolean {
  const real = resolveJail(anchor);
  return real !== null && real === resolveOwnedDirJail(appHome);
}

function locateFlowHome(root: string): Located {
  const file = flowDefinitionFile(root);
  return { ok: true, flowFile: realpathBounded(file) ?? file, load: loadFlowDefinition(root) };
}

function locateCatalogEntry(anchor: string, id: string, appHome: string): Located {
  const tier = isAppHome(anchor, appHome) ? 'global' : 'repo';
  const entry = resolveCatalogEntry({ worktreeDir: anchor, globalRoot: appHome }, id, tier);
  if (!entry.ok) return { ok: false, reason: `this catalog entry ${catalogRefusalReason(entry.cause)}` };
  return loadEntry(entry.flowDir);
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
  return loadEntry(probe.flowDir);
}

function loadEntry(flowDir: string): Located {
  const file = path.join(flowDir, FLOW_DEF_FILE);
  return { ok: true, flowFile: file, load: loadUntrustedFlowDefinition(file) };
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
