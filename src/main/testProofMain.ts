import { runTestProof } from './testProof';
import { createBranchPullRequests, createProofWorkingTree } from './testProofPorts';

const root = process.cwd();
void runTestProof(process.argv.slice(2), {
  workingTree: createProofWorkingTree(root),
  pullRequests: createBranchPullRequests(root),
  report: (line) => process.stderr.write(`${line}\n`),
}).then((code) => {
  process.exitCode = code;
});
