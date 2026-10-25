import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRepoFixture } from './gitRepo';

export function seedFinalizeGit(fx: GitRepoFixture) {
  const remote = fx.makeGitRepo('finalize-remote');
  const repo = fx.makeGitRepo('finalize-work');
  const base = 'release';
  const head = 'feature-251';
  fx.git(remote, ['config', 'core.bare', 'true']);
  fx.writeRepoFile(repo, 'policy.txt', 'original policy\n');
  fx.commitAll(repo, 'Initial policy');
  fx.git(repo, ['remote', 'add', 'origin', remote]);
  fx.git(repo, ['push', 'origin', 'main']);
  fx.git(repo, ['checkout', '-b', base]);
  fx.writeRepoFile(repo, 'policy.txt', 'target policy\n');
  fx.commitAll(repo, 'Target policy');
  fx.git(repo, ['push', 'origin', base]);
  fx.git(repo, ['checkout', '-b', head, 'main']);
  fx.writeRepoFile(repo, 'policy.txt', 'feature policy\n');
  fx.commitAll(repo, 'Feature policy');
  fx.git(repo, ['push', '-u', 'origin', head]);
  return { repo, remote, base, head };
}

interface GhReply {
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}
interface GhCall { args: string[]; stdin: string }

export function seedScriptedGh(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const command = join(bin, 'gh');
  const replies = join(bin, 'replies.json');
  const log = join(bin, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(replies, '[]');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const replies = path.join(__dirname, 'replies.json');
const args = process.argv.slice(2);
const stdin = args.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
const steps = JSON.parse(fs.readFileSync(replies, 'utf8'));
const next = steps[0];
if (!next || JSON.stringify(next.args) !== JSON.stringify(args)) {
  process.stderr.write('Unexpected gh command: ' + JSON.stringify(args));
  process.exit(97);
}
fs.writeFileSync(replies, JSON.stringify(steps.slice(1)));
process.stdout.write(next.stdout ?? '');
process.stderr.write(next.stderr ?? '');
process.exitCode = next.exitCode ?? 0;
`, { mode: 0o755 });
  return {
    command,
    script: (steps: GhReply[]) => writeFileSync(replies, JSON.stringify(steps)),
    calls: (): GhCall[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}
