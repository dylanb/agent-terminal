// A stand-in for Claude Code 2.1.319, run as `claude` (node strips the types) and imported by tests for the shapes it
// writes. It imports nothing from src/: every shape here was read off real Claude Code 2.1.319, never off the app's
// readers. It speaks MCP over stdio as Claude Code does, runs the user's hooks with Claude Code's hook input, and
// writes Claude-shaped transcript entries. A prompt's `mcp <tool> <json>` lines are its tool calls.

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';

export const FAKE_CLAUDE_VERSION = '2.1.319';
export const FAKE_CLAUDE_READY = 'fake-claude: ready';
/** Marks a Claude Code config dir shared by every test of a worker: the fake's `mcp add-json` and `remove` refuse to
 *  write one, so an install into it fails its test instead of leaking into the worker's later tests. It holds the
 *  dir's own path, so a test's private copy (which inherits the file) is not mistaken for the shared dir. */
export const SHARED_CONFIG_MARKER = '.agent-terminal-e2e-shared-config';

export function isSharedClaudeConfig(root: string): boolean {
  try {
    return realpathSync(readFileSync(join(root, SHARED_CONFIG_MARKER), 'utf8')) === realpathSync(root);
  } catch {
    return false;
  }
}
const HOLD_CAP_MS = 30_000;

/** Where Claude Code keeps its user configuration: with CLAUDE_CONFIG_DIR set, its state file moves inside it. */
export interface ClaudeConfigPaths {
  root: string;
  state: string;
  settings: string;
}

export function claudeConfigPaths(env: NodeJS.ProcessEnv): ClaudeConfigPaths {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return { root: override, state: join(override, '.claude.json'), settings: join(override, 'settings.json') };
  const home = env.HOME ?? homedir();
  return { root: join(home, '.claude'), state: join(home, '.claude.json'), settings: join(home, '.claude', 'settings.json') };
}

// ---- transcript entries ----

/** How a prompt reached the session, as the transcript records it. */
export type PromptSource =
  | { kind: 'typed' }
  | { kind: 'queued' }
  | { kind: 'sdk' }
  | { kind: 'task-notification'; producer: string }
  | { kind: 'peer'; name: string; senderTaskId: string };

export interface TranscriptPrompt {
  sessionId: string;
  promptId: string;
  uuid: string;
  text: string;
  cwd: string;
  timestamp: string;
  source: PromptSource;
}

const SOURCE_FIELDS: { [K in PromptSource['kind']]: (source: Extract<PromptSource, { kind: K }>) => Record<string, unknown> } = {
  typed: () => ({ origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' }),
  queued: () => ({ origin: { kind: 'human' }, promptSource: 'queued', turnOrigin: 'human' }),
  sdk: () => ({ promptSource: 'sdk', turnOrigin: 'sdk' }),
  'task-notification': (s) => ({ origin: { kind: 'task-notification', producer: s.producer }, promptSource: 'system', turnOrigin: 'task_notification' }),
  peer: (s) => ({ origin: { kind: 'peer', name: s.name, senderTaskId: s.senderTaskId }, promptSource: 'system', turnOrigin: 'peer' }),
};

/** One user entry of a session transcript, as Claude Code 2.1.319 writes it. */
export function transcriptUserEntry(p: TranscriptPrompt): Record<string, unknown> {
  const source = (SOURCE_FIELDS[p.source.kind] as (s: PromptSource) => Record<string, unknown>)(p.source);
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: p.cwd,
    sessionId: p.sessionId,
    version: FAKE_CLAUDE_VERSION,
    gitBranch: '',
    type: 'user',
    message: { role: 'user', content: p.text },
    uuid: p.uuid,
    timestamp: p.timestamp,
    promptId: p.promptId,
    ...source,
  };
}

/** A transcript's text: one JSON entry per line. */
export const transcriptText = (entries: Record<string, unknown>[]): string => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

/** Claude Code's transcript file for a session started in `cwd`. */
export function transcriptPath(config: ClaudeConfigPaths, cwd: string, sessionId: string): string {
  return join(config.root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

// ---- hook input ----

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
export type SessionEndReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other';

export interface HookSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
}

const hookCommon = (s: HookSession, event: HookEvent) => ({
  session_id: s.sessionId,
  transcript_path: s.transcriptPath,
  cwd: s.cwd,
  permission_mode: 'default',
  hook_event_name: event,
});

/** The JSON Claude Code writes to a hook command's stdin, per event. */
export const hookInput = {
  sessionStart: (s: HookSession, source: SessionStartSource) => ({ ...hookCommon(s, 'SessionStart'), source }),
  userPromptSubmit: (s: HookSession, promptId: string, prompt: string) => ({ ...hookCommon(s, 'UserPromptSubmit'), prompt_id: promptId, prompt }),
  stop: (s: HookSession) => ({ ...hookCommon(s, 'Stop'), stop_hook_active: false }),
  sessionEnd: (s: HookSession, reason: SessionEndReason) => ({ ...hookCommon(s, 'SessionEnd'), reason }),
};

// ---- the log a test reads ----

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** One line of FAKE_CLAUDE_LOG. `error` on a call is a JSON-RPC error the server returned, never a tool's own isError
 *  result; a call the fake never sent (a bad directive, a `$` reference naming nothing, no server listing the tool, a
 *  server already gone) is `call-unsent`, and one whose server went away before answering is `call-lost`. `held` is logged once a turn's work is done and it stays open while FAKE_CLAUDE_HOLD exists. */
export type FakeClaudeRecord =
  | { event: 'cli'; pid: number; argv: string[]; exit: number; stdout: string; stderr: string }
  | { event: 'session'; pid: number; sessionId: string; transcriptPath: string; mode: 'interactive' | 'print'; cause: SessionStartSource }
  | { event: 'tools'; pid: number; server: string; tools: string[] }
  | { event: 'server-failed'; pid: number; server: string; error: string }
  | { event: 'server-exit'; pid: number; server: string; code: number | null; signal: string | null; stderr: string }
  | { event: 'hook'; pid: number; hook: HookEvent; command: string; exit: number | null; stdout: string; stderr: string }
  | { event: 'prompt'; pid: number; sessionId: string; promptId: string; text: string; source: PromptSource['kind'] }
  | { event: 'prompt-blocked'; pid: number; sessionId: string; promptId: string; text: string }
  | { event: 'call'; pid: number; sessionId: string; promptId: string; tool: string; args: unknown; result?: McpCallResult; error?: string }
  | { event: 'call-unsent' | 'call-lost'; pid: number; sessionId: string; promptId: string; tool: string; reason: string }
  | { event: 'held'; pid: number; sessionId: string; promptId: string }
  | { event: 'hold-released'; pid: number; sessionId: string; promptId: string; expired: boolean }
  | { event: 'stop'; pid: number; sessionId: string; promptId: string }
  | { event: 'session-end'; pid: number; sessionId: string; reason: SessionEndReason };

type Unlogged<R> = R extends unknown ? Omit<R, 'pid'> : never;

function logger(env: NodeJS.ProcessEnv): (record: Unlogged<FakeClaudeRecord>) => void {
  const file = env.FAKE_CLAUDE_LOG;
  return (record) => {
    if (file) appendFileSync(file, `${JSON.stringify({ ...record, pid: process.pid })}\n`);
  };
}

// ---- the MCP client ----

/** Every server, hook and agent process still running, killed with the session so none outlives it. */
const liveChildren = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.on('exit', () => liveChildren.delete(child));
  child.on('error', () => liveChildren.delete(child));
  return child;
}


export interface McpServerSpec {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpClient {
  readonly pid: number | undefined;
  readonly tools: McpToolInfo[];
  call(name: string, args: unknown): Promise<McpCallResult>;
  /** Any request, for a test of what the server answers outside the tools Claude Code calls. */
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** The server went away rather than answering: `sent` says whether the request had been written to it. */
export class McpConnectionLost extends Error {
  readonly sent: boolean;
  constructor(message: string, sent: boolean) {
    super(message);
    this.sent = sent;
  }
}

const CLIENT_INFO = {
  name: 'claude-code',
  title: 'Claude Code',
  version: FAKE_CLAUDE_VERSION,
  description: "Anthropic's agentic coding tool",
  websiteUrl: 'https://claude.com/claude-code',
};
const CLIENT_CAPABILITIES = { roots: { listChanged: true }, elicitation: { form: {}, url: {} } };

/** Connect to a stdio server the way Claude Code 2.1.319 does: a `server/discover` probe (whatever it answers),
 *  then `initialize` at 2025-11-25, `notifications/initialized` and `tools/list`. Rejects when the server exits or
 *  fails before the handshake ends. Aborting `signal` kills the server, mid-handshake or later. */
export async function connectMcpServer(
  spec: McpServerSpec,
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onExit?: (code: number | null, signal: string | null, stderr: string) => void },
): Promise<McpClient> {
  const child: ChildProcess = spawn(spec.command, spec.args ?? [], {
    cwd: opts.cwd,
    env: { ...opts.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  track(child);
  const pending = new Map<string | number, Pending>();
  let nextId = 1;
  let stdoutBuf = '';
  let stderr = '';
  let gone: Error | null = null;

  const send = (message: Record<string, unknown>): void => {
    if (gone) return;
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params?: unknown, id: string | number = nextId++): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new McpConnectionLost(gone.message, false));
      pending.set(id, { resolve, reject });
      send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  const fail = (error: Error): void => {
    gone ??= error;
    for (const p of pending.values()) p.reject(new McpConnectionLost(gone.message, true));
    pending.clear();
  };
  const answerServer = (message: { id: string | number; method: string }): void => {
    if (message.method === 'ping') return send({ id: message.id, result: {} });
    if (message.method === 'roots/list') return send({ id: message.id, result: { roots: [{ uri: `file://${opts.cwd}`, name: opts.cwd }] } });
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  };

  child.stdin?.on('error', (e) => fail(e));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => (stderr += d));
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    stdoutBuf += d;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === '') continue;
      let message: { id?: string | number; method?: string; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        fail(new Error(`server wrote a line that is not JSON: ${line.slice(0, 200)}`));
        child.kill();
        return;
      }
      if (message.method !== undefined && message.id !== undefined) answerServer(message as { id: string | number; method: string });
      else if (message.id !== undefined && pending.has(message.id)) {
        const p = pending.get(message.id) as Pending;
        pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else p.resolve(message.result);
      }
    }
  });
  child.on('error', (e) => fail(e));
  child.on('exit', (code, signal) => {
    fail(new Error(`server exited (code ${code}, signal ${signal})${stderr ? `: ${stderr.trim()}` : ''}`));
    opts.onExit?.(code, signal, stderr);
  });

  try {
    await request(
      'server/discover',
      { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': CLIENT_CAPABILITIES } },
      'server-discover-probe-1',
    ).catch((e: unknown) => {
      if (gone) throw e;
    });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO }, 0);
    send({ method: 'notifications/initialized' });
    const listed = (await request('tools/list')) as { tools?: McpToolInfo[] };
    return {
      pid: child.pid,
      tools: listed.tools ?? [],
      call: async (name, args) => (await request('tools/call', { name, arguments: args })) as McpCallResult,
      request: (method, params) => request(method, params),
      close: () => {
        child.stdin?.end();
        child.kill();
      },
    };
  } catch (e) {
    child.kill();
    throw e;
  }
}

// ---- `claude mcp …` ----

type CliOutcome = { exit: number; stdout: string; stderr: string };

function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed as Record<string, unknown>;
}

function writeJsonObject(file: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.fake-claude-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** `claude mcp add-json|remove|get|list`, user scope only: any other scope would write the repository (`.mcp.json`)
 *  or the project entry, which nothing in agent-terminal may do, so it fails here as loudly as a bad argument. */
function mcpCli(argv: string[], env: NodeJS.ProcessEnv): CliOutcome {
  const [sub, ...rest] = argv;
  let scope: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-s' || a === '--scope') scope = rest[++i];
    else if (a.startsWith('--scope=')) scope = a.slice('--scope='.length);
    else if (a.startsWith('-')) return { exit: 1, stdout: '', stderr: `fake claude: unsupported option ${a}\n` };
    else positional.push(a);
  }
  const needsUser = sub === 'add-json' || sub === 'remove';
  if (needsUser && scope !== 'user') return { exit: 1, stdout: '', stderr: `fake claude: only --scope user is supported (got ${scope ?? 'none'})\n` };
  if (needsUser && isSharedClaudeConfig(claudeConfigPaths(env).root)) return { exit: 1, stdout: '', stderr: `fake claude: refusing to ${sub} in the worker's shared Claude Code config; give the test its own with seedIsolatedClaudeConfig\n` };
  const file = claudeConfigPaths(env).state;
  let state: Record<string, unknown>;
  try {
    state = readJsonObject(file);
  } catch (e) {
    return { exit: 1, stdout: '', stderr: `${e instanceof Error ? e.message : String(e)}\n` };
  }
  const servers = { ...((state.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  const [name, json] = positional;
  switch (sub) {
    case 'add-json': {
      if (!name || json === undefined || positional.length !== 2) return { exit: 1, stdout: '', stderr: 'usage: claude mcp add-json --scope user <name> <json>\n' };
      if (name in servers) return { exit: 1, stdout: '', stderr: `MCP server ${name} already exists in user config\n` };
      let spec: unknown;
      try {
        spec = JSON.parse(json);
      } catch (e) {
        return { exit: 1, stdout: '', stderr: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}\n` };
      }
      writeJsonObject(file, { ...state, mcpServers: { ...servers, [name]: spec } });
      return { exit: 0, stdout: `Added stdio MCP server ${name} to user config\n`, stderr: '' };
    }
    case 'remove': {
      if (!name || positional.length !== 1) return { exit: 1, stdout: '', stderr: 'usage: claude mcp remove --scope user <name>\n' };
      if (!(name in servers)) return { exit: 1, stdout: '', stderr: `No MCP server named "${name}" in user scope\n` };
      delete servers[name];
      writeJsonObject(file, { ...state, mcpServers: servers });
      return { exit: 0, stdout: `Removed MCP server ${name} from user config\nFile modified: ${file}\n`, stderr: '' };
    }
    case 'get':
      if (!name || !(name in servers)) return { exit: 1, stdout: '', stderr: `No MCP server named "${name ?? ''}". Run \`claude mcp add\` to add one.\n` };
      return { exit: 0, stdout: `${name}:\n  Scope: User config\n  ${JSON.stringify(servers[name])}\n`, stderr: '' };
    case 'list':
      return { exit: 0, stdout: Object.keys(servers).map((n) => `${n}: ${JSON.stringify(servers[n])}\n`).join(''), stderr: '' };
    default:
      return { exit: 1, stdout: '', stderr: `fake claude: unsupported mcp subcommand ${sub ?? '(none)'}\n` };
  }
}

// ---- hooks ----

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string }[] };

function readHooks(file: string): Partial<Record<HookEvent, HookGroup[]>> {
  if (!existsSync(file)) return {};
  const settings = readJsonObject(file);
  return (settings.hooks as Partial<Record<HookEvent, HookGroup[]>> | undefined) ?? {};
}

function runCommand(command: string, input: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    track(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => resolve({ exit: null, stdout, stderr: stderr + e.message }));
    child.on('close', (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.end(input);
  });
}

// ---- the session ----

/** A prompt's tool calls: each `mcp <tool> <json>` line, in order. A string argument `$<tool>.<path>` is replaced by
 *  that path in the latest result of `<tool>` this session got (its structuredContent, else its text as JSON). */
export const DIRECTIVE = /^mcp\s+([A-Za-z0-9_-]+)\s*(.*)$/;

function resultValue(result: McpCallResult | undefined): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function substitute(value: unknown, latest: Map<string, McpCallResult>): unknown {
  if (typeof value === 'string') {
    const ref = /^\$([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/.exec(value);
    if (!ref) return value;
    let at: unknown = resultValue(latest.get(ref[1]));
    for (const key of ref[2].split('.').slice(1)) at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
    if (at === undefined) throw new Error(`${value} names nothing in the latest ${ref[1]} result`);
    return at;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, latest));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, latest)]));
  return value;
}

const VALUE_FLAGS = new Set(['--model', '--permission-mode', '--append-system-prompt', '--add-dir', '--settings', '--output-format', '--input-format']);

interface LaunchArgs {
  print: boolean;
  prompt: string | undefined;
}

function parseLaunch(argv: string[]): LaunchArgs {
  let print = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') print = true;
    else if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) words.push(a);
  }
  return { print, prompt: words.length > 0 ? words.join(' ') : undefined };
}

function out(text: string): void {
  process.stdout.write(text.replace(/\r?\n/g, '\r\n'));
}

/** Resolves once `path` is gone, or with true after `capMs`, so a hold nobody releases fails its test on that test's
 *  own assertion. */
function whileExists(path: string, capMs: number): Promise<boolean> {
  const until = Date.now() + capMs;
  return new Promise((done) => {
    const poll = () => {
      if (!existsSync(path)) return done(false);
      if (Date.now() >= until) return done(true);
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function session(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const log = logger(env);
  const config = claudeConfigPaths(env);
  const cwd = process.cwd();
  const launch = parseLaunch(argv);
  const interactive = !launch.print && process.stdin.isTTY === true;
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0').slice(-width);
  const counters = { session: 0, prompt: 0, entry: 0 };
  const id = (kind: number, n: number) => `${hex(process.pid, 8)}-000${kind}-4000-8000-${hex(n, 12)}`;
  const newSessionId = () => id(0, ++counters.session);

  let hooks: Partial<Record<HookEvent, HookGroup[]>> = {};
  try {
    hooks = readHooks(config.settings);
  } catch (e) {
    out(`fake-claude: settings unreadable, no hooks run: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  const clients = new Map<string, McpClient>();
  const latest = new Map<string, McpCallResult>();
  let current: HookSession = { sessionId: newSessionId(), transcriptPath: '', cwd };
  current.transcriptPath = transcriptPath(config, cwd, current.sessionId);

  const runHooks = async (event: HookEvent, input: Record<string, unknown>, match?: string): Promise<number[]> => {
    const exits: number[] = [];
    for (const group of hooks[event] ?? []) {
      if (match !== undefined && group.matcher && group.matcher !== '*' && !group.matcher.split('|').includes(match)) continue;
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || !hook.command) continue;
        const r = await runCommand(hook.command, JSON.stringify(input), cwd, { ...env, CLAUDE_PROJECT_DIR: cwd });
        log({ event: 'hook', hook: event, command: hook.command, exit: r.exit, stdout: r.stdout, stderr: r.stderr });
        if (r.exit !== null) exits.push(r.exit);
      }
    }
    return exits;
  };
  const begin = async (cause: SessionStartSource): Promise<void> => {
    log({ event: 'session', sessionId: current.sessionId, transcriptPath: current.transcriptPath, mode: interactive ? 'interactive' : 'print', cause });
    await runHooks('SessionStart', hookInput.sessionStart(current, cause), cause);
  };
  const end = async (reason: SessionEndReason): Promise<void> => {
    await runHooks('SessionEnd', hookInput.sessionEnd(current, reason), reason);
    log({ event: 'session-end', sessionId: current.sessionId, reason });
  };

  const closeAll = () => {
    for (const c of clients.values()) c.close();
    for (const child of liveChildren) child.kill();
  };
  process.on('exit', closeAll);
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(129));
  let servers: Record<string, McpServerSpec> = {};
  try {
    servers = (readJsonObject(config.state).mcpServers as Record<string, McpServerSpec> | undefined) ?? {};
  } catch (e) {
    out(`fake-claude: ${config.state} unreadable, no MCP servers: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  for (const [name, spec] of Object.entries(servers)) {
    try {
      const client = await connectMcpServer(spec, {
        cwd,
        env,
        onExit: (code, signal, stderr) => log({ event: 'server-exit', server: name, code, signal, stderr }),
      });
      clients.set(name, client);
      log({ event: 'tools', server: name, tools: client.tools.map((t) => t.name) });
    } catch (e) {
      log({ event: 'server-failed', server: name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // FAKE_CLAUDE_AGENT is the scripted agent (seedFakeAgentSteps' `fake-agent`) that does each turn's work: it reads
  // the prompt on stdin and writes to the session's own terminal, as Claude Code's own output would.
  const runAgent = (text: string): Promise<void> =>
    new Promise((resolve) => {
      const agent = env.FAKE_CLAUDE_AGENT;
      if (!agent) return resolve();
      const child = spawn('bash', [agent], { cwd, env, stdio: ['pipe', 'inherit', 'inherit'] });
      track(child);
      child.on('error', (e) => {
        out(`fake-claude: agent failed to start: ${e.message}\n`);
        resolve();
      });
      child.on('exit', () => resolve());
      child.stdin.on('error', () => {});
      child.stdin.end(`${text}\n`);
    });

  const record = async (promptId: string, text: string, source: PromptSource): Promise<boolean> => {
    const blocked = (await runHooks('UserPromptSubmit', hookInput.userPromptSubmit(current, promptId, text))).includes(2);
    if (blocked) {
      log({ event: 'prompt-blocked', sessionId: current.sessionId, promptId, text });
      out('fake-claude: prompt blocked by a hook\n');
      return false;
    }
    const entry = transcriptUserEntry({ sessionId: current.sessionId, promptId, uuid: id(2, ++counters.entry), text, cwd, timestamp: new Date().toISOString(), source });
    mkdirSync(dirname(current.transcriptPath), { recursive: true });
    appendFileSync(current.transcriptPath, transcriptText([entry]));
    log({ event: 'prompt', sessionId: current.sessionId, promptId, text, source: source.kind });
    return true;
  };
  const work = async (promptId: string, text: string): Promise<void> => {
    for (const line of text.split('\n')) {
      const d = DIRECTIVE.exec(line.trim());
      if (!d) continue;
      const tool = d[1];
      let args: unknown;
      let client: McpClient | undefined;
      try {
        args = substitute(d[2].trim() === '' ? {} : JSON.parse(d[2]), latest);
        client = [...clients.values()].find((c) => c.tools.some((t) => t.name === tool));
        if (!client) throw new Error(`no connected server lists ${tool}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log({ event: 'call-unsent', sessionId: current.sessionId, promptId, tool, reason });
        out(`fake-claude: ${tool} -> not sent: ${reason}\n`);
        continue;
      }
      try {
        const result = await client.call(tool, args);
        latest.set(tool, result);
        log({ event: 'call', sessionId: current.sessionId, promptId, tool, args, result });
        out(`fake-claude: ${tool} -> ${result.isError ? 'error' : 'ok'} ${result.content?.find((c) => c.type === 'text')?.text ?? ''}\n`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (e instanceof McpConnectionLost) {
          log({ event: e.sent ? 'call-lost' : 'call-unsent', sessionId: current.sessionId, promptId, tool, reason: error });
          out(`fake-claude: ${tool} -> ${e.sent ? 'connection lost' : 'not sent'}: ${error}\n`);
          continue;
        }
        log({ event: 'call', sessionId: current.sessionId, promptId, tool, args, error });
        out(`fake-claude: ${tool} -> protocol error ${error}\n`);
      }
    }
    await runAgent(text);
  };

  // The turn whose tool calls or agent are running. A prompt typed then joins it, as in Claude Code 2.1.319: it is
  // reported at once under the open turn's prompt_id, and its work runs in that turn, before the one Stop.
  let open: { promptId: string; joined: string[]; recording: Promise<unknown> } | null = null;
  const join = (text: string): boolean => {
    const turnNow = open;
    if (turnNow === null) return false;
    turnNow.recording = turnNow.recording.then(async () => {
      if (await record(turnNow.promptId, text, { kind: 'queued' })) turnNow.joined.push(text);
    });
    return true;
  };
  const turn = async (text: string, source: PromptSource): Promise<void> => {
    const promptId = id(1, ++counters.prompt);
    if (!(await record(promptId, text, source))) return;
    const turnNow = { promptId, joined: [text], recording: Promise.resolve() as Promise<unknown> };
    open = turnNow;
    let held = false;
    for (;;) {
      const next = turnNow.joined.shift();
      if (next !== undefined) {
        await work(promptId, next);
        continue;
      }
      const settled = turnNow.recording;
      await settled;
      if (turnNow.joined.length > 0 || turnNow.recording !== settled) continue;
      const hold = env.FAKE_CLAUDE_HOLD;
      if (held || !hold || !existsSync(hold)) break;
      held = true;
      log({ event: 'held', sessionId: current.sessionId, promptId });
      const expired = await whileExists(hold, HOLD_CAP_MS);
      log({ event: 'hold-released', sessionId: current.sessionId, promptId, expired });
    }
    open = null;
    await runHooks('Stop', hookInput.stop(current));
    log({ event: 'stop', sessionId: current.sessionId, promptId });
  };

  if (!interactive) {
    let text = launch.prompt ?? '';
    if (launch.prompt === undefined && process.stdin.isTTY !== true) {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk;
      text = text.replace(/\n$/, '');
    }
    await begin('startup');
    await turn(text, { kind: 'sdk' });
    await end('other');
    closeAll();
    return 0;
  }

  await begin('startup');
  out(`\x1b[?2004h${FAKE_CLAUDE_READY} (${[...clients.values()].reduce((n, c) => n + c.tools.length, 0)} tools)\n> `);
  const queue: { text: string; source: PromptSource }[] = [];
  let busy = false;
  let quitting = false;
  const builtin = async (text: string): Promise<boolean> => {
    if (text === '/exit') {
      quitting = true;
      await end('prompt_input_exit');
      closeAll();
      process.exit(0);
    }
    if (text === '/clear') {
      await end('clear');
      latest.clear();
      current = { sessionId: newSessionId(), transcriptPath: '', cwd };
      current.transcriptPath = transcriptPath(config, cwd, current.sessionId);
      await begin('clear');
    } else if (text === '/compact' || text.startsWith('/compact ')) await begin('compact');
    else return false;
    await runAgent(text);
    return true;
  };
  const drain = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    while (queue.length > 0 && !quitting) {
      const { text, source } = queue.shift() as { text: string; source: PromptSource };
      if (!(await builtin(text))) await turn(text, source);
      out('> ');
    }
    busy = false;
  };
  if (launch.prompt !== undefined) queue.push({ text: launch.prompt, source: { kind: 'typed' } });

  let pending = '';
  let buffer = '';
  let inPaste = false;
  const START = '\x1b[200~';
  const END = '\x1b[201~';
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    while (pending.length > 0) {
      if (pending.startsWith(START)) {
        inPaste = true;
        pending = pending.slice(START.length);
        continue;
      }
      if (pending.startsWith(END)) {
        inPaste = false;
        pending = pending.slice(END.length);
        continue;
      }
      if (pending[0] === '\x1b') {
        if (START.startsWith(pending) || END.startsWith(pending)) return;
        const seq = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|.)/.exec(pending);
        if (!seq) return;
        pending = pending.slice(seq[0].length);
        continue;
      }
      const ch = pending[0];
      pending = pending.slice(1);
      if (inPaste) {
        buffer += ch === '\r' ? '\n' : ch;
        out(ch === '\r' ? '\n' : ch);
      } else if (ch === '\r' || ch === '\n') {
        const text = buffer.trim();
        buffer = '';
        out('\n');
        if (text !== '') {
          if (text.startsWith('/') || !join(text)) {
            queue.push({ text, source: busy ? { kind: 'queued' } : { kind: 'typed' } });
            void drain();
          }
        }
      } else if (ch === '\x7f' || ch === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          out('\b \b');
        }
      } else if (ch === '\x03' || (ch === '\x04' && buffer === '')) {
        if (buffer !== '' && ch === '\x03') {
          buffer = '';
          out('\n> ');
        } else {
          quitting = true;
          void end('prompt_input_exit').finally(() => {
            closeAll();
            process.exit(0);
          });
        }
      } else if (ch >= ' ' || ch === '\t') {
        buffer += ch;
        out(ch);
      }
    }
  });
  if (queue.length > 0) void drain();
  return new Promise<number>(() => {});
}

/** The `claude` program: `--version`, `mcp …`, or a session (interactive on a terminal; `-p` or piped stdin prints). */
export async function runFakeClaude(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${FAKE_CLAUDE_VERSION} (Claude Code)\n`);
    return;
  }
  const config = claudeConfigPaths(env);
  const within = (dir: string, path: string) => {
    const rel = relative(dir, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const touchesOperator = [config.root, config.state].find((p) => within(userInfo().homedir, p) && !within(tmpdir(), p));
  if (touchesOperator !== undefined) {
    process.stderr.write(`fake claude: refusing to use ${touchesOperator}, which is the operator's own Claude Code configuration; give the test a temp CLAUDE_CONFIG_DIR or HOME\n`);
    process.exitCode = 70;
    return;
  }
  if (argv[0] === 'mcp') {
    const r = mcpCli(argv.slice(1), env);
    logger(env)({ event: 'cli', argv, exit: r.exit, stdout: r.stdout, stderr: r.stderr });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.exit;
    return;
  }
  process.exitCode = await session(argv, env);
}
