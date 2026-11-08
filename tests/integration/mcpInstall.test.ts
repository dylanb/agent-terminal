import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMcpIntegration, removeMcpIntegration, type McpIntegrationTarget } from '../../src/main/mcpInstall';
import { readFakeClaudeLog, runFakeClaude, seedFakeClaude } from '../helpers/fakeClaudeHarness';
import { SHARED_CONFIG_MARKER } from '../helpers/fakeClaude';

const LAUNCH = { command: '/Users/op/.agent-terminal/bin/agent-terminal-mcp', args: ['--mcp-entry'] };
const GUARD_HOOK_EVENTS = ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'];

const USER_STATE = {
  numStartups: 4,
  mcpServers: { mine: { type: 'stdio', command: 'my-server', args: ['--quiet'] } },
  projects: { '/work/x': { allowedTools: [] } },
};
const USER_SETTINGS = {
  theme: 'dark',
  permissions: { allow: ['Bash(ls)'] },
  hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Machine {
  target: McpIntegrationTarget;
  root: string;
  state: string;
  settings: string;
  log: string;
}

function machine(): Machine {
  const base = mkdtempSync(join(tmpdir(), 'agent-term-mcp-install-'));
  dirs.push(base);
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const root = join(base, 'claude-config');
  const { command, logFile } = seedFakeClaude(bin);
  return {
    target: { claude: command, env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: root }, launch: LAUNCH },
    root,
    state: join(root, '.claude.json'),
    settings: join(root, 'settings.json'),
    log: logFile,
  };
}

function seedUserConfig(m: Machine): void {
  mkdirSync(m.root, { recursive: true });
  writeFileSync(m.state, JSON.stringify(USER_STATE, null, 2));
  writeFileSync(m.settings, JSON.stringify(USER_SETTINGS, null, 2));
}

/** The integration as installed: its server registered through Claude Code, and one hook per guard event whose
 *  command runs the installed launch, beside the operator's own entries. */
async function seedInstalled(m: Machine): Promise<void> {
  seedUserConfig(m);
  const added = await runFakeClaude(m.target.claude, ['mcp', 'add-json', '--scope', 'user', 'agent-terminal', JSON.stringify({ type: 'stdio', ...LAUNCH })], { env: m.target.env, cwd: m.root });
  if (added.exit !== 0) throw new Error(`seeding the installed server failed: ${added.stderr}`);
  const hooks: Record<string, unknown[]> = structuredClone(USER_SETTINGS.hooks);
  for (const event of GUARD_HOOK_EVENTS) hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command: `'${LAUNCH.command}' ${LAUNCH.args.join(' ')} --hook` }] }];
  writeFileSync(m.settings, JSON.stringify({ ...USER_SETTINGS, hooks }, null, 2));
}

const readJson = (file: string): Record<string, unknown> => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {});
const bytes = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const files = (m: Machine) => ({ state: bytes(m.state), settings: bytes(m.settings) });
const servers = (file: string): Record<string, unknown> => (readJson(file).mcpServers as Record<string, unknown> | undefined) ?? {};
type HookGroups = { hooks?: { command?: string }[] }[];
const hooks = (file: string): Record<string, HookGroups> => (readJson(file).hooks as Record<string, HookGroups> | undefined) ?? {};
const eventsRunning = (file: string, command: string): string[] =>
  Object.entries(hooks(file))
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => (h.command ?? '').includes(command))))
    .map(([event]) => event)
    .sort();
/** The `claude mcp` commands Claude Code ran successfully, as `<subcommand> <server>`. */
const claudeMcpRuns = (m: Machine): string[] =>
  readFakeClaudeLog(m.log).flatMap((r) => (r.event === 'cli' && r.exit === 0 && ['add-json', 'remove'].includes(r.argv[1] ?? '') ? [`${r.argv[1]} ${r.argv.filter((a) => !a.startsWith('-') && a !== 'user').slice(2, 3).join('')}`] : []));

describe('installing the Claude Code integration', () => {
  it("on a machine where Claude Code has never run, registers the server through Claude Code and adds the guard's hooks, creating the configuration", async () => {
    const m = machine();
    const result = await installMcpIntegration(m.target);
    expect({ result, server: servers(m.state)['agent-terminal'], hookEvents: eventsRunning(m.settings, LAUNCH.command), viaClaudeCode: claudeMcpRuns(m) }).toEqual({
      result: { ok: true },
      server: expect.objectContaining(LAUNCH),
      hookEvents: GUARD_HOOK_EVENTS,
      viaClaudeCode: ['add-json agent-terminal'],
    });
  });

  it('keeps every other configuration value, and installing again changes nothing', async () => {
    const m = machine();
    seedUserConfig(m);
    await installMcpIntegration(m.target);
    const afterFirst = files(m);
    const again = await installMcpIntegration(m.target);
    const { 'agent-terminal': ours, ...others } = servers(m.state);
    expect({
      ours,
      others,
      stateRest: { ...readJson(m.state), mcpServers: undefined },
      settingsRest: { ...readJson(m.settings), hooks: undefined },
      operatorHooks: hooks(m.settings).UserPromptSubmit?.filter((g) => !(g.hooks ?? []).some((h) => (h.command ?? '').includes(LAUNCH.command))),
      again,
      afterSecond: files(m),
    }).toEqual({
      ours: expect.objectContaining(LAUNCH),
      others: USER_STATE.mcpServers,
      stateRest: { ...USER_STATE, mcpServers: undefined },
      settingsRest: { ...USER_SETTINGS, hooks: undefined },
      operatorHooks: USER_SETTINGS.hooks.UserPromptSubmit,
      again: { ok: true },
      afterSecond: afterFirst,
    });
  });

  it('fails naming the settings file when it is not valid JSON, and writes nothing', async () => {
    const m = machine();
    seedUserConfig(m);
    writeFileSync(m.settings, '{ "theme": "dark",');
    const before = files(m);
    const result = await installMcpIntegration(m.target);
    expect({ result, files: files(m) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, files: before });
  });

  it('fails naming the settings file when it cannot be read, and writes nothing', async () => {
    const m = machine();
    mkdirSync(m.settings, { recursive: true });
    const result = await installMcpIntegration(m.target);
    expect({ result, state: bytes(m.state) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, state: null });
  });

  it('fails saying Claude Code was not found when there is no claude to run, and writes nothing', async () => {
    const m = machine();
    const result = await installMcpIntegration({ ...m.target, claude: join(m.root, '..', 'nowhere', 'claude') });
    expect({ result, configCreated: existsSync(m.root) }).toEqual({ result: { ok: false, error: expect.stringContaining('Claude Code') }, configCreated: false });
  });

  it("fails with Claude Code's own reason when it refuses to register the server, and leaves the settings unchanged", async () => {
    const m = machine();
    seedUserConfig(m);
    writeFileSync(join(m.root, SHARED_CONFIG_MARKER), m.root);
    const before = files(m);
    const result = await installMcpIntegration(m.target);
    expect({ result, files: files(m) }).toEqual({ result: { ok: false, error: expect.stringContaining("refusing to add-json in the worker's shared Claude Code config") }, files: before });
  });

  it('with no CLAUDE_CONFIG_DIR, installs into and removes from the configuration Claude Code reads under HOME', async () => {
    const m = machine();
    const home = m.target.env.HOME as string;
    const target = { ...m.target, env: { PATH: process.env.PATH, HOME: home } };
    const state = join(home, '.claude.json');
    const settings = join(home, '.claude', 'settings.json');
    const installed = await installMcpIntegration(target);
    const afterInstall = { server: servers(state)['agent-terminal'], hookEvents: eventsRunning(settings, LAUNCH.command) };
    const removed = await removeMcpIntegration(target);
    expect({ installed, afterInstall, removed, afterRemove: { server: servers(state)['agent-terminal'], hookEvents: eventsRunning(settings, LAUNCH.command) } }).toEqual({
      installed: { ok: true },
      afterInstall: { server: expect.objectContaining(LAUNCH), hookEvents: GUARD_HOOK_EVENTS },
      removed: { ok: true },
      afterRemove: { server: undefined, hookEvents: [] },
    });
  });
});

describe('removing the Claude Code integration', () => {
  it('takes out only its own server, through Claude Code, and its own hooks', async () => {
    const m = machine();
    await seedInstalled(m);
    const result = await removeMcpIntegration(m.target);
    expect({ result, state: readJson(m.state), settings: readJson(m.settings), viaClaudeCode: claudeMcpRuns(m).slice(1) }).toEqual({
      result: { ok: true },
      state: USER_STATE,
      settings: USER_SETTINGS,
      viaClaudeCode: ['remove agent-terminal'],
    });
  });

  it('succeeds and changes nothing when the integration is not installed', async () => {
    const m = machine();
    seedUserConfig(m);
    const before = files(m);
    const result = await removeMcpIntegration(m.target);
    expect({ result, files: files(m) }).toEqual({ result: { ok: true }, files: before });
  });

  it('fails naming the settings file when it is not valid JSON, and writes nothing', async () => {
    const m = machine();
    await seedInstalled(m);
    writeFileSync(m.settings, '{ "hooks": ');
    const before = files(m);
    const result = await removeMcpIntegration(m.target);
    expect({ result, files: files(m) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, files: before });
  });

  it('fails naming the settings file when it cannot be read, keeping the server registered', async () => {
    const m = machine();
    await seedInstalled(m);
    const state = bytes(m.state);
    rmSync(m.settings);
    mkdirSync(m.settings);
    const result = await removeMcpIntegration(m.target);
    expect({ result, state: bytes(m.state), viaClaudeCode: claudeMcpRuns(m).slice(1) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, state, viaClaudeCode: [] });
  });

  it('fails saying Claude Code was not found when there is no claude to run, and writes nothing', async () => {
    const m = machine();
    await seedInstalled(m);
    const before = files(m);
    const result = await removeMcpIntegration({ ...m.target, claude: join(m.root, '..', 'nowhere', 'claude') });
    expect({ result, files: files(m) }).toEqual({ result: { ok: false, error: expect.stringContaining('Claude Code') }, files: before });
  });
});
