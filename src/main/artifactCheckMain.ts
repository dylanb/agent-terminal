// Standalone installed runtime for format checks and finalization access.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { runArtifactCheck } from './artifactCheck';
import { runFinalizeAccess } from './finalizeAccess';
import { errMsg } from './errno';
import { VALIDATE_FLOW_FLAG } from './cliShim';
import { resolveAppHome } from './launchRoot';
import { resolveAppLoopDefTiers } from './appLoopDefTiers';
import { runValidateFlow } from './validateFlow';

const args = process.argv.slice(2);
if (args[0] === 'audit-evidence' || args[0] === 'publish-flow-audit') {
  void runFinalizeAccess(args).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${errMsg(error)}\n`);
    process.exitCode = 1;
  });
} else if (args[0] === VALIDATE_FLOW_FLAG) {
  const { exitCode, stdout, stderr } = runValidateFlow(args.slice(1), {
    cwd: () => process.cwd(),
    appHome: resolveAppHome(process.env, os.homedir()),
    loopTiers: resolveAppLoopDefTiers({ packaged: false, appPath: __dirname }),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} else {
  const { exitCode, output } = runArtifactCheck(args, (rel) => {
    try {
      return readFileSync(rel, 'utf8');
    } catch {
      return null;
    }
  });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
