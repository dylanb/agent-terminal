// The stand-in for the `claude` CLI in print mode (#180 test boundary): the benchmark's whole-run tests drive
// the real runtime against this process instead of a model. It speaks the print-mode surface the benchmark
// uses — argv flags, the prompt on stdin, stream-json on stdout, a session transcript under the config root —
// and does what the test's behaviour file scripts for each turn.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { completionMarker } from '../../../src/main/appWorkTurn';
import { exampleRoundReport } from '../../../src/shared/roundReport';
import { exampleConsolidatorOutput } from '../../../src/shared/consolidatorOutput';
import { readPrompt, type ReadPrompt } from './promptReader';
import {
  DEFAULT_USAGE,
  STAND_IN_STATE_ENV,
  STAND_IN_VERSION,
  appendLog,
  currentRunIndex,
  gateReleased,
  markWaiting,
  nextOccurrence,
  nthEntry,
  readBehaviour,
  recordPid,
  runIndexFor,
  scriptForRun,
  type StandInTurn,
  type StandInUsage,
  type StandInWrite,
} from './protocol';

const FIXED_TIMESTAMP = '2020-01-01T00:00:00.000Z';
const POLL_MS = 10;

interface Args {
  print: boolean;
  version: boolean;
  outputFormat: string;
  verbose: boolean;
  model: string;
  sessionId: string | null;
  resume: string | null;
  tools: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { print: false, version: false, outputFormat: 'text', verbose: false, model: 'default', sessionId: null, resume: null, tools: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => argv[++i] ?? '';
    if (flag === '-p' || flag === '--print') a.print = true;
    else if (flag === '-v' || flag === '--version') a.version = true;
    else if (flag === '--verbose') a.verbose = true;
    else if (flag === '--output-format') a.outputFormat = value();
    else if (flag === '--model') a.model = value();
    else if (flag === '--session-id') a.sessionId = value();
    else if (flag === '--resume' || flag === '-r') a.resume = value();
    else if (flag === '--tools') a.tools = value();
  }
  return a;
}

const stateDir = process.env[STAND_IN_STATE_ENV];
if (stateDir === undefined || stateDir === '') {
  process.stderr.write(`stand-in: ${STAND_IN_STATE_ENV} is not set\n`);
  process.exit(2);
}
const state: string = stateDir;

function loggedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== STAND_IN_STATE_ENV && v !== undefined) env[k] = v;
  return env;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[STAND_IN_STATE_ENV];
  return env;
}

function configRoot(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== '' ? dir : join(process.env.HOME ?? '', '.claude');
}

function transcriptFile(workspace: string, sessionId: string): string {
  return join(configRoot(), 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function emit(args: Args, event: unknown): void {
  if (args.outputFormat === 'stream-json') process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function waitForGate(name: string): Promise<void> {
  markWaiting(state, name);
  while (!gateReleased(state, name)) await new Promise((r) => setTimeout(r, POLL_MS));
}

function hang(): Promise<never> {
  setInterval(() => {}, 1 << 30);
  return new Promise<never>(() => {});
}

function writeRel(cwd: string, rel: string, content: string): void {
  const file = isAbsolute(rel) ? rel : join(cwd, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeTarget(read: ReadPrompt, w: StandInWrite): string {
  if ('rel' in w.to) return w.to.rel;
  const rel = w.to.round === 'report' ? read.reportRel : read.verdictRel;
  if (rel === null) throw new Error(`stand-in: a ${w.to.round} write, but the prompt names no ${w.to.round} path`);
  return rel;
}

function defaultProduct(read: ReadPrompt): StandInWrite[] {
  if (read.phase === 'work' && read.artifactRel !== null && read.step !== null) {
    return [{ to: { rel: read.artifactRel }, content: `# ${read.step}\n\n${completionMarker(read.step)}\n` }];
  }
  if (read.phase === 'review' && read.roster.length > 0) {
    return [{ to: { round: 'report' }, content: exampleRoundReport({ sections: read.sections, roster: read.roster.map((r) => r.persona) }) }];
  }
  if (read.phase === 'consolidate') {
    return [{ to: { round: 'consolidator' }, content: exampleConsolidatorOutput('clean', read.catalog) }];
  }
  return [];
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function runShell(run: number, key: string, cwd: string, commands: string[] | undefined): void {
  for (const command of commands ?? []) {
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { cwd, env: childEnv(), encoding: 'utf8' });
    appendLog(state, 'shell', { run, key, command, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  }
}

function finish(pid: number, run: number | null, key: string | null, code: number): never {
  appendLog(state, 'exits', { pid, run, key, code });
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function agent(args: Args, usage: StandInUsage): Promise<void> {
  const cwd = realpathSync(process.cwd());
  const run = runIndexFor(state, cwd);
  appendLog(state, 'launches', { pid: process.pid, mode: 'agent', argv: process.argv.slice(2), cwd, env: loggedEnv(), run });
  if (args.outputFormat === 'stream-json' && !args.verbose) {
    process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
    finish(process.pid, run, null, 1);
  }
  const sessionId = args.sessionId ?? args.resume ?? '';
  const transcript = transcriptFile(cwd, sessionId);
  if (args.resume !== null && !existsSync(transcript)) {
    process.stderr.write(`No conversation found with session ID: ${args.resume}\n`);
    finish(process.pid, run, null, 1);
  }
  if (args.sessionId !== null && existsSync(transcript)) {
    process.stderr.write(`Error: Session ID ${args.sessionId} is already in use.\n`);
    finish(process.pid, run, null, 1);
  }
  const prompt = await readStdin();
  const read = readPrompt(prompt);
  const key = read.key ?? 'reply';
  const occurrence = nextOccurrence(state, run, key);
  appendLog(state, 'prompts', { run, sessionId, key, occurrence, prompt });
  const script = scriptForRun(readBehaviour(state), run);
  const turn: StandInTurn = (read.key === null ? nthEntry(script.replies, occurrence) : nthEntry(script.turns?.[key], occurrence)) ?? {};

  emit(args, { type: 'system', subtype: 'init', session_id: sessionId, cwd, model: args.model, tools: [] });
  for (const r of read.roster) if (r.charter !== null) appendLog(state, 'reads', { run, key, path: r.charter, content: readIfPresent(r.charter) });
  for (const rel of read.inputRels) appendLog(state, 'reads', { run, key, path: rel, content: readIfPresent(join(cwd, rel)) });

  const withProduct = turn.defaultProduct ?? turn.writes === undefined;
  const writes = [...(withProduct ? defaultProduct(read) : []), ...(turn.writes ?? [])];
  for (const w of writes) writeRel(cwd, writeTarget(read, w), w.content);
  runShell(run, key, cwd, turn.shell);

  for (const ev of turn.events ?? [{}]) {
    if (ev.waitFor !== undefined) await waitForGate(ev.waitFor);
    emit(args, { type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: args.model, content: [{ type: 'text', text: ev.text ?? `stand-in ${key}` }] } });
  }
  mkdirSync(dirname(transcript), { recursive: true });
  const base = { cwd, sessionId, isSidechain: false, userType: 'external', version: STAND_IN_VERSION, timestamp: FIXED_TIMESTAMP };
  appendFileSync(transcript, `${JSON.stringify({ ...base, type: 'user', uuid: uuidFrom(`${sessionId}:${key}:${occurrence}:u`), message: { role: 'user', content: prompt } })}\n`);
  appendFileSync(
    transcript,
    `${JSON.stringify({ ...base, type: 'assistant', uuid: uuidFrom(`${sessionId}:${key}:${occurrence}:a`), message: { role: 'assistant', model: args.model, content: [{ type: 'text', text: `stand-in ${key}` }], usage } })}\n`,
  );

  if (turn.holdBeforeDone !== undefined) await waitForGate(turn.holdBeforeDone);
  if (turn.done !== false && read.doneRel !== null && read.key !== null) writeRel(cwd, read.doneRel, read.key);

  emit(args, { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: `stand-in ${key}`, num_turns: 1, duration_ms: 0, total_cost_usd: 0, usage });
  if (args.outputFormat === 'json') process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: `stand-in ${key}`, usage })}\n`);
  if (args.outputFormat === 'text') process.stdout.write(`stand-in ${key}\n`);
  if (turn.holdBeforeExit !== undefined) await waitForGate(turn.holdBeforeExit);
  if (turn.exit === 'never') await hang();
  finish(process.pid, run, key, turn.exitCode ?? 0);
}

async function judge(args: Args, usage: StandInUsage): Promise<void> {
  const cwd = realpathSync(process.cwd());
  const run = currentRunIndex(state);
  appendLog(state, 'launches', { pid: process.pid, mode: 'judge', argv: process.argv.slice(2), cwd, env: loggedEnv(), run });
  const prompt = await readStdin();
  const script = scriptForRun(readBehaviour(state), run).judge ?? {};
  runShell(run, 'judge', cwd, script.shell);
  const byId = Object.entries(script.replyById ?? {})
    .filter(([id]) => prompt.includes(id))
    .map(([, text]) => text);
  const reply = byId.length > 0 ? byId.join('\n') : (script.reply ?? '');
  appendLog(state, 'judge', { run, prompt, reply });
  const sessionId = uuidFrom(`judge:${run}:${prompt.length}`);
  if (args.outputFormat === 'stream-json') {
    emit(args, { type: 'system', subtype: 'init', session_id: sessionId, cwd, model: args.model, tools: [] });
    emit(args, { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: reply, usage });
  } else if (args.outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: reply, usage })}\n`);
  } else {
    process.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`);
  }
  finish(process.pid, run, 'judge', script.exitCode ?? 0);
}

async function main(): Promise<void> {
  recordPid(state, process.pid);
  const args = parseArgs(process.argv.slice(2));
  const usage = readBehaviour(state).usage ?? DEFAULT_USAGE;
  if (args.version) {
    appendLog(state, 'launches', { pid: process.pid, mode: 'version', argv: process.argv.slice(2), cwd: process.cwd(), env: loggedEnv(), run: null });
    process.stdout.write(`${STAND_IN_VERSION}\n`);
    finish(process.pid, null, null, 0);
  }
  if (args.print && args.tools === '') return judge(args, usage);
  if (args.print && (args.sessionId !== null || args.resume !== null)) return agent(args, usage);
  appendLog(state, 'launches', { pid: process.pid, mode: 'usage-error', argv: process.argv.slice(2), cwd: process.cwd(), env: loggedEnv(), run: null });
  process.stderr.write('stand-in: expected -p with --session-id/--resume (agent) or --tools "" (judge)\n');
  finish(process.pid, null, null, 2);
}

void main();
