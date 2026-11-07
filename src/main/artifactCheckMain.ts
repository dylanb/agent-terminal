// Standalone installed runtime for format checks and finalization access.
import { runArtifactCheck } from './artifactCheck';
import { artifactCheckInputs } from './artifactCheckInputs';
import { runFinalizeAccess } from './finalizeAccess';
import { errMsg } from './errno';

const args = process.argv.slice(2);
if (args[0] === 'audit-evidence' || args[0] === 'publish-flow-audit') {
  void runFinalizeAccess(args).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${errMsg(error)}\n`);
    process.exitCode = 1;
  });
} else {
  const { exitCode, output } = runArtifactCheck(args, artifactCheckInputs(process.cwd()));
  process.stdout.write(output);
  process.exitCode = exitCode;
}
