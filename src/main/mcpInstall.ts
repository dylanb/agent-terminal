import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCP_HOOK_ARG, MCP_SERVER_NAME } from '../shared/mcp';
import { shellQuote } from '../shared/shellQuote';
import type { ClaudeCodeIntegrationResult } from '../shared/ipc';
import { atomicWriteFileSync } from './atomicFile';
import { errMsg, isErrno } from './errno';
import { mergePaths, resolveShellPath, terminalShellArgs } from './pty';
import { userClaudeStateFileFrom, userConfigRootFrom } from './userConfig';

/** What the install and remove actions act on: the `claude` executable that runs `claude mcp`, the environment
 *  Claude Code runs with (it locates the configuration), and how Claude Code launches the server and its hooks. */
export interface McpIntegrationTarget {
  /** An absolute path; any other value is never run, and fails as "Claude Code was not found". */
  claude: string;
  env: NodeJS.ProcessEnv;
  launch: { command: string; args: string[] };
}

export type McpIntegrationResult = ClaudeCodeIntegrationResult;

const GUARD_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;

const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

type HookGroup = { hooks?: unknown[] } & Record<string, unknown>;
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

class IntegrationFailure extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const NO_CONFIG_DIR = 'Claude Code has no configuration directory to install into: set CLAUDE_CONFIG_DIR to an absolute path, or unset it to use ~/.claude.';

function settingsFile(env: NodeJS.ProcessEnv): string {
  const root = userConfigRootFrom(env, env.HOME ?? os.homedir());
  if (root === null) throw new IntegrationFailure(NO_CONFIG_DIR);
  return path.join(root, 'settings.json');
}

async function readSettings(file: string): Promise<{ settings: Settings; bytes: string | null }> {
  let bytes: string;
  try {
    bytes = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { settings: {}, bytes: null };
    throw new IntegrationFailure(`Could not read the Claude Code settings file ${file}: ${errMsg(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new IntegrationFailure(`The Claude Code settings file ${file} is not valid JSON: ${errMsg(error)}`);
  }
  if (!isRecord(parsed)) throw new IntegrationFailure(`The Claude Code settings file ${file} does not hold a JSON object.`);
  const hooks = parsed.hooks;
  const readableGroup = (group: unknown): boolean => isRecord(group) && (group.hooks === undefined || Array.isArray(group.hooks));
  if (hooks !== undefined && (!isRecord(hooks) || Object.values(hooks).some((groups) => !Array.isArray(groups) || !groups.every(readableGroup)))) {
    throw new IntegrationFailure(`The hooks in the Claude Code settings file ${file} are not in the form Claude Code reads.`);
  }
  return { settings: parsed as Settings, bytes };
}

/** `dir` with every symbolic link resolved, or as given when it does not exist yet. */
async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return dir;
    throw error;
  }
}

async function writeSettings(file: string, settings: Settings, existed: boolean): Promise<void> {
  const target = existed ? await realpath(file) : path.join(await realDir(path.dirname(file)), path.basename(file));
  const mode = existed ? (await stat(target)).mode & 0o777 : 0o600;
  if (!atomicWriteFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, { mode })) {
    throw new IntegrationFailure(`The Claude Code settings file ${file} was not written: its directory is a symbolic link.`);
  }
}

function hookCommand(launch: McpIntegrationTarget['launch']): string {
  return [launch.command, ...launch.args].map(shellQuote).concat(MCP_HOOK_ARG).join(' ');
}

/** A hook is the integration's own when its command runs the installed launch. */
function isOurHook(hook: unknown, launch: McpIntegrationTarget['launch']): boolean {
  const command = isRecord(hook) && typeof hook.command === 'string' ? hook.command : null;
  const ours = shellQuote(launch.command);
  return command !== null && (command === ours || command.startsWith(`${ours} `));
}

function withOurHooks(settings: Settings, launch: McpIntegrationTarget['launch']): Settings | null {
  const hooks = { ...(settings.hooks ?? {}) };
  let changed = false;
  for (const event of GUARD_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    if (groups.some((group) => (group.hooks ?? []).some((hook) => isOurHook(hook, launch)))) continue;
    hooks[event] = [...groups, { hooks: [{ type: 'command', command: hookCommand(launch) }] }];
    changed = true;
  }
  return changed ? { ...settings, hooks } : null;
}

function withoutOurHooks(settings: Settings, launch: McpIntegrationTarget['launch']): Settings | null {
  if (settings.hooks === undefined) return null;
  let changed = false;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const own = (group.hooks ?? []).filter((hook) => !isOurHook(hook, launch));
      if (own.length === (group.hooks ?? []).length) kept.push(group);
      else {
        changed = true;
        if (own.length > 0) kept.push({ ...group, hooks: own });
      }
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!changed) return null;
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

interface ClaudeRun {
  exit: number;
  output: string;
}

export const CLAUDE_NOT_FOUND = 'Claude Code was not found on your PATH or through your login shell. Install Claude Code, then try again.';

function runClaude(target: McpIntegrationTarget, args: string[]): Promise<ClaudeRun> {
  const claude = target.claude;
  if (!path.isAbsolute(claude)) return Promise.reject(new IntegrationFailure(CLAUDE_NOT_FOUND));
  return new Promise((resolve, reject) => {
    execFile(claude, args, { env: target.env, cwd: os.tmpdir(), timeout: CLAUDE_COMMAND_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      const output = (stderr.trim() || stdout.trim()).trim();
      if (error === null) return resolve({ exit: 0, output });
      if (typeof error.code === 'number') return resolve({ exit: error.code, output });
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        return reject(new IntegrationFailure(`Claude Code was not found: there is no claude command to run at ${claude}. Install Claude Code, then try again.`));
      }
      reject(new IntegrationFailure(`Claude Code did not finish ${['claude', ...args.slice(0, 2)].join(' ')}: ${errMsg(error)}`));
    });
  });
}

/** Claude Code's own state file, where `claude mcp` keeps user-scope servers. Read only: every write goes through
 *  `claude mcp`, so Claude Code's own concurrent writes to it are never lost. */
function stateFile(env: NodeJS.ProcessEnv): string {
  const file = userClaudeStateFileFrom(env, env.HOME ?? os.homedir());
  if (file === null) throw new IntegrationFailure(NO_CONFIG_DIR);
  return file;
}

/** Whether Claude Code has no server under the integration's name, has the integration's own (it runs the launch),
 *  or has one that is someone else's. */
async function registeredServer(target: McpIntegrationTarget): Promise<{ kind: 'absent' } | { kind: 'ours' } | { kind: 'theirs'; command: string }> {
  const file = stateFile(target.env);
  let bytes: string;
  try {
    bytes = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'absent' };
    throw new IntegrationFailure(`Could not read Claude Code's state file ${file}: ${errMsg(error)}`);
  }
  let state: unknown;
  try {
    state = JSON.parse(bytes);
  } catch (error) {
    throw new IntegrationFailure(`Claude Code's state file ${file} is not valid JSON: ${errMsg(error)}`);
  }
  const servers = isRecord(state) && isRecord(state.mcpServers) ? state.mcpServers : {};
  const entry = servers[MCP_SERVER_NAME];
  if (entry === undefined) return { kind: 'absent' };
  const command = isRecord(entry) && typeof entry.command === 'string' ? entry.command : JSON.stringify(entry);
  return command === target.launch.command ? { kind: 'ours' } : { kind: 'theirs', command };
}

/** The hooks half of a change whose server half Claude Code has already made: a failure here says which half is
 *  done, since the same action run again finishes it. */
async function afterServerChange(done: string, action: 'Install' | 'Remove', hooks: () => Promise<void>): Promise<void> {
  try {
    await hooks();
  } catch (error) {
    const reason = error instanceof IntegrationFailure ? error.message : errMsg(error);
    throw new IntegrationFailure(`${done}: ${reason} ${action} again to finish.`);
  }
}

async function attempt(work: () => Promise<void>): Promise<McpIntegrationResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    if (error instanceof IntegrationFailure) return { ok: false, error: error.message };
    return { ok: false, error: `The Claude Code integration could not be changed: ${errMsg(error)}` };
  }
}

/** Registers the agent-terminal server with Claude Code at user scope, through `claude mcp` so Claude Code's own
 *  writes to its state file are never lost, and adds the hooks the guard needs to its settings. Adds only its own
 *  entries and adds nothing that is already there. A settings file it cannot read or parse, or no `claude`, fails
 *  before anything is written. */
export function installMcpIntegration(target: McpIntegrationTarget): Promise<McpIntegrationResult> {
  return attempt(async () => {
    const file = settingsFile(target.env);
    await readSettings(file);
    const registered = await registeredServer(target);
    if (registered.kind === 'theirs') {
      throw new IntegrationFailure(`Claude Code already has a user-scope MCP server named ${MCP_SERVER_NAME} that runs ${registered.command}, which is not this app's. Remove it with \`claude mcp remove --scope user ${MCP_SERVER_NAME}\`, then install again.`);
    }
    if (registered.kind === 'absent') {
      const added = await runClaude(target, ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify({ type: 'stdio', ...target.launch })]);
      if (added.exit !== 0) throw new IntegrationFailure(`Claude Code did not register the agent-terminal server: ${added.output || `claude mcp add-json exited ${added.exit}`}`);
    }
    await afterServerChange(`The agent-terminal server was registered with Claude Code, but its hooks were not written`, 'Install', async () => {
      const fresh = await readSettings(file);
      const next = withOurHooks(fresh.settings, target.launch);
      if (next !== null) await writeSettings(file, next, fresh.bytes !== null);
    });
  });
}

/** Takes out only the integration's own server, through `claude mcp`, and its own hooks. */
export function removeMcpIntegration(target: McpIntegrationTarget): Promise<McpIntegrationResult> {
  return attempt(async () => {
    const file = settingsFile(target.env);
    await readSettings(file);
    const ours = (await registeredServer(target)).kind === 'ours';
    if (ours) {
      const removed = await runClaude(target, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
      if (removed.exit !== 0) throw new IntegrationFailure(`Claude Code did not remove the agent-terminal server: ${removed.output || `claude mcp remove exited ${removed.exit}`}`);
    }
    const removeHooks = async (): Promise<void> => {
      const fresh = await readSettings(file);
      const next = withoutOurHooks(fresh.settings, target.launch);
      if (next !== null) await writeSettings(file, next, fresh.bytes !== null);
    };
    if (ours) await afterServerChange('The agent-terminal server was removed from Claude Code, but its hooks were not removed', 'Remove', removeHooks);
    else await removeHooks();
  });
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Where Claude Code is, and how the window's terminal would run it: with its shell's PATH (an npm install's
 *  `#!/usr/bin/env node` needs it) and its shell's CLAUDE_CONFIG_DIR, which the sessions in the window read. */
export interface FoundClaude {
  claude: string;
  path: string;
  claudeConfigDir?: string;
}

const MARK = 'agent-terminal-claude-probe';

/** Asks the user's shell the way the window's terminal starts it, and interactive, as the terminal's PTY makes it, so
 *  `.zshrc` or `.bashrc` is read too. Startup files may print anything, so only the marked lines are read. */
function shellLookup(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ claude: string | null; path: string; claudeConfigDir?: string } | null> {
  const script = `c=$(command -v claude 2>/dev/null); printf '\\n${MARK}:claude:%s\\n${MARK}:path:%s\\n${MARK}:config:%s\\n' "$c" "$PATH" "\${CLAUDE_CONFIG_DIR-}"`;
  return new Promise((resolve) => {
    // An interactive shell ignores SIGTERM, so only SIGKILL makes the timeout end a startup file that never returns.
    const child = execFile(resolveShellPath(env), [...terminalShellArgs(platform), '-i', '-c', script], { env, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
      if (error !== null && typeof error.code !== 'number') return resolve(null);
      const marked = (key: string): string | undefined =>
        stdout.split('\n').find((line) => line.startsWith(`${MARK}:${key}:`))?.slice(`${MARK}:${key}:`.length).trim();
      const found = marked('claude') ?? '';
      const configDir = marked('config') ?? '';
      resolve({
        claude: path.isAbsolute(found) ? found : null,
        path: marked('path') ?? '',
        ...(configDir !== '' ? { claudeConfigDir: configDir } : {}),
      });
    });
    child.stdin?.end();
  });
}

/** The `claude` the install action runs: the one in an absolute directory on the app's PATH, else the one the user's
 *  shell finds (an app started from the desktop inherits a PATH that rarely holds it), run with that shell's PATH added
 *  and its CLAUDE_CONFIG_DIR; else null. */
export async function findClaude(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, opts: { shellTimeoutMs?: number } = {}): Promise<FoundClaude | null> {
  const current = env.PATH ?? '';
  const shell = await shellLookup(platform, env, opts.shellTimeoutMs ?? CLAUDE_COMMAND_TIMEOUT_MS);
  const merged = shell === null ? current : mergePaths(current, shell.path);
  // A relative entry would resolve `node` (an npm install's interpreter) against the child's working directory.
  const absoluteOnly = merged.split(path.delimiter).filter((dir) => path.isAbsolute(dir)).join(path.delimiter);
  const runWith = { path: absoluteOnly, ...(shell?.claudeConfigDir !== undefined ? { claudeConfigDir: shell.claudeConfigDir } : {}) };
  for (const dir of current.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'claude');
    if (await isExecutable(candidate)) return { claude: candidate, ...runWith };
  }
  return shell?.claude && await isExecutable(shell.claude) ? { claude: shell.claude, ...runWith } : null;
}
