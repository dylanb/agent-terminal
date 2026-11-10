import path from 'node:path';
import { selectFlowFolder, type ValidateFlowDeps } from './validateFlow';
import { resolveLoopDefV2 } from './loopDefV2';
import { CLAUDE_REVIEWER_AGENT, CODEX_REVIEWER_AGENT, readCharter, type ReviewerAgentFormat } from './reviewerAgents';
import { applyInstallExamplesWithAuthorization, destRelative, installFileVerdict, prepareInstallExamples, type InstallDestination, type PlannedFile } from './installExamples';
import { userConfigAgentsDir } from './userConfig';
import { codexAgentsDir } from './codexConfig';
import { CLI_COMMAND_NAME, INSTALL_REVIEWERS_FLAG } from './cliShim';
import { errMsg } from './errno';
import { stripDisplayControlChars } from '../shared/controlChars';
import type { InstallDestinationId, InstallDestinationNotInstalled } from '../shared/ipc';

export interface InstallReviewersDeps extends ValidateFlowDeps {
  configDir?: string;
  codexHome: string | null;
  write(text: string): void;
  confirm(question: string): Promise<boolean>;
}

function reviewerFiles(folder: string, deps: ValidateFlowDeps, format: ReviewerAgentFormat): PlannedFile[] {
  const selected = selectFlowFolder(folder, deps);
  if (!selected.ok) throw new Error(`${selected.problem.file}: ${selected.problem.text}`);
  const files = new Map<string, PlannedFile>();
  for (const step of selected.definition.steps) {
    if (step.loop === undefined) continue;
    const resolved = resolveLoopDefV2(step.loop, selected.loops);
    if (!resolved.ok) throw new Error(`${folder}: ${resolved.reason}`);
    for (const reviewer of resolved.def.reviewers) {
      const render = (): Buffer => {
        const charter = readCharter(reviewer.charter);
        if (!charter.ok) throw new Error(charter.problem);
        return Buffer.from(format.render({ flow: selected.definition.name, loop: step.loop!, persona: reviewer.persona, tools: reviewer.tools, charter: charter.text }));
      };
      const rel = destRelative(`${format.name(step.loop, reviewer.persona, selected.definition.name)}${format.extension}`);
      const prior = files.get(rel);
      const bytes = render();
      if (prior !== undefined && !prior.bytes().equals(bytes)) throw new Error(`${folder}: conflicting reviewer ${rel}`);
      files.set(rel, { rel, src: reviewer.charter, bytes: render });
    }
  }
  return [...files.values()];
}

function destinations(folder: string, deps: InstallReviewersDeps): InstallDestination[] {
  return [
    { id: 'agents', targetDir: userConfigAgentsDir(deps.configDir), rootFix: 'Set CLAUDE_CONFIG_DIR to an absolute path.', format: CLAUDE_REVIEWER_AGENT },
    { id: 'codexAgents', targetDir: deps.codexHome === null ? null : codexAgentsDir(deps.codexHome), rootFix: 'Set CODEX_HOME to an absolute path.', format: CODEX_REVIEWER_AGENT,
      ...(deps.codexHome === null ? {} : { toolHome: deps.codexHome }) },
  ].map(({ format, ...destination }) => ({ ...destination, id: destination.id as InstallDestinationId,
    bundleDir: folder, overwrite: { mode: 'confirm-overwrite' }, plan: () => reviewerFiles(folder, deps, format) }));
}

export async function runInstallReviewers(operands: readonly string[], deps: InstallReviewersDeps): Promise<number> {
  const say = (text: string): void => deps.write(`${stripDisplayControlChars(text)}\n`);
  const reportNotInstalled = (destinations: InstallDestinationNotInstalled[]): void => {
    for (const skipped of destinations) say(`skipped (unavailable): ${skipped.destination}, ${skipped.root} is absent`);
  };
  if (operands.length !== 1) {
    say(`usage: ${CLI_COMMAND_NAME} ${INSTALL_REVIEWERS_FLAG} <flow-folder>`);
    return 2;
  }
  let folder = operands[0];
  try {
    folder = path.isAbsolute(folder) ? path.resolve(folder) : path.resolve(deps.cwd(), folder);
    const prepared = prepareInstallExamples(destinations(folder, deps));
    if (!prepared.ok) { say(prepared.error); return 1; }
    const { authorization } = prepared.prepared;
    say(`Reviewers for ${folder}`);
    for (const file of authorization.files) say(`${installFileVerdict(file)}: ${file.real}`);
    const replace: InstallDestinationId[] = [];
    const changes = authorization.files.some((file) => installFileVerdict(file) !== 'identical');
    if (changes) {
      for (const destination of prepared.prepared.destinations) {
        if (destination.conflict && await deps.confirm(`Replace edited reviewers in ${destination.destination}? [y/N] `)) replace.push(destination.destination);
      }
      if (!await deps.confirm('Install the selected changes? [y/N] ')) {
        say('Cancelled. No reviewer files were changed; outstanding reviewers remain unavailable.');
        for (const file of authorization.files) {
          if (installFileVerdict(file) !== 'identical') say(`unavailable: ${file.destination}/${file.rel}`);
        }
        reportNotInstalled(prepared.prepared.notInstalled);
        return 3;
      }
    }
    const result = applyInstallExamplesWithAuthorization(destinations(folder, deps), replace, { removeRetired: false }, authorization);
    for (const [label, groups] of [['created', result.created], ['replaced', result.overwritten]] as const) {
      for (const group of groups) for (const rel of group.files) say(`${label}: ${group.destination}/${rel}`);
    }
    for (const group of result.skipped) for (const rel of group.files) {
      const file = authorization.files.find((f) => f.destination === group.destination && f.rel === rel);
      say(`${file !== undefined && installFileVerdict(file) === 'identical' ? 'unchanged' : 'declined (unavailable)'}: ${group.destination}/${rel}`);
    }
    reportNotInstalled(result.notInstalled);
    if (!result.ok) { say(result.error); say('Installation incomplete; completed writes above remain. Correct the cause and retry.'); return 1; }
    if (result.created.length + result.overwritten.length > 0) say('Start a fresh agent session to load the installed reviewers.');
    if (authorization.files.length === 0) say('Nothing needs installation.');
    return 0;
  } catch (error) {
    say(`${folder}: ${errMsg(error)}`);
    return 1;
  }
}
