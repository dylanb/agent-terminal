import { errMsg } from './errno';
import { runTestProof } from './testProof';
import { createBranchPullRequests, createProofPublisher, createProofSuites, createProofWorkingTree } from './testProofPorts';

const root = process.cwd();
const report = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
runTestProof(process.argv.slice(2), {
  workingTree: createProofWorkingTree(root),
  pullRequests: createBranchPullRequests(root),
  suites: createProofSuites(root),
  publisher: createProofPublisher(root),
  report,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    report(`test:proof failed: ${errMsg(e)}`);
    process.exitCode = 1;
  },
);
