// Standalone installed runtime for format checks and finalization access.
import os from 'node:os';
import { runArtifactCheck } from './artifactCheck';
import { artifactCheckInputs } from './artifactCheckInputs';
import { runFinalizeAccess } from './finalizeAccess';
import { errMsg } from './errno';
import { CHECK_REPEAT_LIST_FLAG, INSTALL_REVIEWERS_FLAG, VALIDATE_FLOW_FLAG } from './cliShim';
import { runCheckRepeatList } from './checkRepeatList';
import { resolveAppHome } from './launchRoot';
import { resolveAppLoopDefTiers } from './appLoopDefTiers';
import { runValidateFlow } from './validateFlow';

import { runInstallReviewers } from './installReviewers';
import { codexHome } from './codexConfig';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args[0] === 'audit-evidence' || args[0] === 'publish-flow-audit') {
  void runFinalizeAccess(args).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${errMsg(error)}\n`);
    process.exitCode = 1;
  });
} else if (args[0] === INSTALL_REVIEWERS_FLAG) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const lines = input[Symbol.asyncIterator]();
  let interrupted = false;
  const interrupt = (): void => { interrupted = true; input.close(); };
  process.on('SIGINT', interrupt);
  input.on('SIGINT', interrupt);
  void runInstallReviewers(args.slice(1), {
    cwd: () => process.cwd(),
    appHome: resolveAppHome(process.env, os.homedir()),
    loopTiers: resolveAppLoopDefTiers({ packaged: false, appPath: __dirname }),
    codexHome: codexHome(),
    write: (text) => { process.stdout.write(text); },
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      process.stdout.write(question);
      const answer = await lines.next();
      return !answer.done && /^y(?:es)?$/i.test(answer.value.trim());
    },
  }).then(async (code) => {
    await setImmediate();
    await setImmediate();
    if (interrupted) process.stdout.write('Interrupted. Completed writes reported above remain; retry installation to reconcile outstanding reviewers.\n');
    process.exitCode = interrupted ? 3 : code;
  }).catch((error: unknown) => {
    process.stderr.write(`${errMsg(error)}\n`);
    process.exitCode = 1;
  }).finally(() => { input.close(); process.removeListener('SIGINT', interrupt); });
} else if (args[0] === VALIDATE_FLOW_FLAG) {
  const { exitCode, stdout, stderr } = runValidateFlow(args.slice(1), {
    cwd: () => process.cwd(),
    appHome: resolveAppHome(process.env, os.homedir()),
    loopTiers: resolveAppLoopDefTiers({ packaged: false, appPath: __dirname }),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} else if (args[0] === CHECK_REPEAT_LIST_FLAG) {
  const { exitCode, stdout, stderr } = runCheckRepeatList(args.slice(1), { cwd: () => process.cwd() });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} else {
  const { exitCode, output } = runArtifactCheck(args, artifactCheckInputs(process.cwd()));
  process.stdout.write(output);
  process.exitCode = exitCode;
}
