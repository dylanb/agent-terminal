import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';

export type ReviewerSessionSpec =
  | { kind: 'claude'; agentsDir: string; reviewers: readonly { name: string; instructions: string; tools: 'all' | readonly string[] }[] }
  | { kind: 'codex'; agentsDir: string; reviewers: readonly { name: string; instructions: string }[] };

export interface ReviewerSession {
  startupShell: string;
  observeLineShell: string;
  executions: string;
}

export function prepareReviewerSession(binDir: string, spec: ReviewerSessionSpec): ReviewerSession {
  const config = join(binDir, 'reviewer-session.json');
  const script = join(binDir, 'reviewer-session.cjs');
  const executions = join(binDir, 'reviewer-executions.jsonl');
  writeFileSync(config, JSON.stringify(spec));
  writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const yaml = require(${JSON.stringify(require.resolve('js-yaml'))});
const toml = require(${JSON.stringify(require.resolve('smol-toml'))});
const spec = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
const [mode, session, line] = process.argv.slice(2);
const snapshot = ${JSON.stringify(join(binDir, 'reviewer-snapshot-'))} + session + '.json';
if (mode === 'start') {
  const loaded = {};
  for (const reviewer of spec.reviewers) {
    const file = path.join(spec.agentsDir, reviewer.name + (spec.kind === 'claude' ? '.md' : '.toml'));
    try { loaded[reviewer.name] = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; loaded[reviewer.name] = null; }
  }
  fs.writeFileSync(snapshot, JSON.stringify(loaded));
} else {
  const marker = spec.kind === 'claude' ? ' — subagent_type: ' : ' — agent: ';
  if (!line.startsWith('- ') || !line.includes(marker)) process.exit(0);
  const name = line.slice(line.indexOf(marker) + marker.length).trim();
  const expected = spec.reviewers.find((reviewer) => reviewer.name === name);
  if (!expected) throw new Error('unexpected reviewer requested: ' + name);
  const text = JSON.parse(fs.readFileSync(snapshot, 'utf8'))[name];
  if (text === null || text === undefined) throw new Error('reviewer not loaded at session start: ' + name);
  let actual;
  if (spec.kind === 'claude') {
    const match = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(text);
    if (!match) throw new Error('invalid Claude reviewer: ' + name);
    const front = yaml.load(match[1]);
    actual = { name: front.name, instructions: match[2], tools: front.tools === undefined ? 'all' : front.tools.split(',').map((tool) => tool.trim()) };
  } else {
    const fields = toml.parse(text);
    actual = { name: fields.name, instructions: fields.developer_instructions };
  }
  if (actual.name !== expected.name || actual.instructions !== expected.instructions || JSON.stringify(actual.tools) !== JSON.stringify(expected.tools)) {
    throw new Error('installed reviewer contract differs: ' + name);
  }
  fs.appendFileSync(${JSON.stringify(executions)}, JSON.stringify({ session, ...actual }) + '\\n');
}
`);
  const command = `node ${shellQuote(script)}`;
  return {
    startupShell: `REVIEWER_SESSION=$$; ${command} start "$REVIEWER_SESSION" || exit 1`,
    observeLineShell: `case "$line" in '- '*' — agent: '*|'- '*' — subagent_type: '*) ${command} check "$REVIEWER_SESSION" "$line" || exit 1 ;; esac`,
    executions,
  };
}
