import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface PublicationState {
  body: string;
  reject: boolean;
  discard: boolean;
  writes: string[];
  calls: string[][];
}

export function seedAuditPublicationGh(bin: string, body: string) {
  mkdirSync(bin, { recursive: true });
  const stateFile = join(bin, 'publication.json');
  const read = (): PublicationState => JSON.parse(readFileSync(stateFile, 'utf8'));
  const write = (state: PublicationState) => writeFileSync(stateFile, JSON.stringify(state));
  write({ body, reject: false, discard: false, writes: [], calls: [] });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'publication.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
state.calls.push(args);
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'fixture/project', url: 'https://github.com/fixture/project', defaultBranchRef: { name: 'main' } }));
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '41') {
  process.stdout.write(JSON.stringify({ number: 41, body: state.body, state: 'OPEN', headRefName: 'feature-251' }));
} else if (args[0] === 'pr' && args[1] === 'edit' && args[2] === '41') {
  const bodyFile = option('--body-file');
  const body = fs.readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8');
  if (state.reject) { process.stderr.write('publication rejected'); process.exitCode = 1; }
  else { state.writes.push(body); if (!state.discard) state.body = body; }
} else {
  process.stderr.write('Unexpected GitHub operation: ' + JSON.stringify(args));
  process.exitCode = 97;
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o755 });
  return { read, set: (patch: Partial<PublicationState>) => write({ ...read(), ...patch }) };
}
