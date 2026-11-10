import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('writes through a settings file that is a symbolic link, keeping the link, on install and on remove', async () => {
    const m = machine();
    seedUserConfig(m);
    const real = join(m.root, '..', 'dotfiles-settings.json');
    renameSync(m.settings, real);
    symlinkSync(real, m.settings);
    await installMcpIntegration(m.target);
    const installed = { link: lstatSync(m.settings).isSymbolicLink(), hookEvents: eventsRunning(real, LAUNCH.command) };
    await removeMcpIntegration(m.target);
    expect({ installed, removed: { link: lstatSync(m.settings).isSymbolicLink(), settings: readJson(real) } }).toEqual({
      installed: { link: true, hookEvents: GUARD_HOOK_EVENTS },
      removed: { link: true, settings: USER_SETTINGS },
    });
  });

  it('installs into a configuration directory that is a symbolic link and holds no settings yet', async () => {
    const m = machine();
    const real = join(m.root, '..', 'dotfiles-claude');
    mkdirSync(real);
    symlinkSync(real, m.root);
    const result = await installMcpIntegration(m.target);
    expect({ result, link: lstatSync(m.root).isSymbolicLink(), hookEvents: eventsRunning(join(real, 'settings.json'), LAUNCH.command) }).toEqual({ result: { ok: true }, link: true, hookEvents: GUARD_HOOK_EVENTS });
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

  it('fails naming the settings file when a hook group is not in the form Claude Code reads, and writes nothing', async () => {
    const m = machine();
    seedUserConfig(m);
    writeFileSync(m.settings, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: 'x' }] } }));
    const before = files(m);
    const result = await installMcpIntegration(m.target);
    expect({ result, files: files(m), viaClaudeCode: claudeMcpRuns(m) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, files: before, viaClaudeCode: [] });
  });

  it('never runs a claude named without a path, even one the search path would find, and writes nothing', async () => {
    const m = machine();
    const result = await installMcpIntegration({ ...m.target, claude: 'claude', env: { ...m.target.env, PATH: `${dirname(m.log)}:${process.env.PATH}` } });
    expect({ result, configCreated: existsSync(m.root), ran: readFakeClaudeLog(m.log).length }).toEqual({ result: { ok: false, error: expect.stringContaining('Claude Code was not found') }, configCreated: false, ran: 0 });
  });

  it('fails naming the settings file when it holds JSON that is not an object, and writes nothing', async () => {
    const m = machine();
    seedUserConfig(m);
    writeFileSync(m.settings, '[]');
    const before = files(m);
    const result = await installMcpIntegration(m.target);
    expect({ result, files: files(m), viaClaudeCode: claudeMcpRuns(m) }).toEqual({ result: { ok: false, error: expect.stringContaining(m.settings) }, files: before, viaClaudeCode: [] });
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

describe("a server named agent-terminal that is not the integration's own", () => {
  const theirs = { type: 'stdio', command: '/opt/someone-else/agent-terminal', args: [] };
  const seedTheirs = (m: Machine): void => {
    seedUserConfig(m);
    writeFileSync(m.state, JSON.stringify({ ...USER_STATE, mcpServers: { ...USER_STATE.mcpServers, 'agent-terminal': theirs } }, null, 2));
  };

  it('makes install fail naming it, writing nothing', async () => {
    const m = machine();
    seedTheirs(m);
    const before = files(m);
    const result = await installMcpIntegration(m.target);
    expect({ result, files: files(m), viaClaudeCode: claudeMcpRuns(m) }).toEqual({ result: { ok: false, error: expect.stringContaining(theirs.command) }, files: before, viaClaudeCode: [] });
  });

  it('is left alone by remove', async () => {
    const m = machine();
    seedTheirs(m);
    const state = bytes(m.state);
    const result = await removeMcpIntegration(m.target);
    expect({ result, state: bytes(m.state), viaClaudeCode: claudeMcpRuns(m) }).toEqual({ result: { ok: true }, state, viaClaudeCode: [] });
  });
});

describe('removing the Claude Code integration', () => {
  it.each(['absent', 'theirs'])('removes leftover integration hooks with an %s server, preserving the server configuration', async kind => {
    const m = machine();
    await seedInstalled(m);
    const state = kind === 'absent' ? USER_STATE : {
      ...USER_STATE,
      mcpServers: { ...USER_STATE.mcpServers, 'agent-terminal': { command: '/opt/other-server', args: [] } },
    };
    writeFileSync(m.state, JSON.stringify(state, null, 2));
    const before = bytes(m.state);
    const result = await removeMcpIntegration(m.target);
    expect({ result, state: bytes(m.state), settings: readJson(m.settings) }).toEqual({
      result: { ok: true }, state: before, settings: USER_SETTINGS,
    });
  });

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

  it("fails with Claude Code's own reason when it refuses to remove the server, keeping the hooks and the server", async () => {
    const m = machine();
    await seedInstalled(m);
    writeFileSync(join(m.root, SHARED_CONFIG_MARKER), m.root);
    const before = files(m);
    const result = await removeMcpIntegration(m.target);
    expect({ result, files: files(m), registered: servers(m.state)['agent-terminal'] !== undefined }).toEqual({
      result: { ok: false, error: expect.stringContaining("refusing to remove in the worker's shared Claude Code config") },
      files: before,
      registered: true,
    });
  });

  it('fails saying Claude Code was not found when there is no claude to run, and writes nothing', async () => {
    const m = machine();
    await seedInstalled(m);
    const before = files(m);
    const result = await removeMcpIntegration({ ...m.target, claude: join(m.root, '..', 'nowhere', 'claude') });
    expect({ result, files: files(m) }).toEqual({ result: { ok: false, error: expect.stringContaining('Claude Code') }, files: before });
  });
});

it.each(['install', 'remove'] as const)('%s refuses a Claude executable without execute permission and preserves configuration', async action => {
  const m = machine();
  if (action === 'remove') await seedInstalled(m);
  else seedUserConfig(m);
  const before = files(m);
  chmodSync(m.target.claude, 0o600);
  const result = await (action === 'install' ? installMcpIntegration(m.target) : removeMcpIntegration(m.target));
  expect(result).toEqual({ ok: false, error: expect.stringMatching(/Claude Code was not found.*Install Claude Code/s) });
  expect(files(m)).toEqual(before);
});

describe('a change that stops after Claude Code has changed its server entry', () => {
  /** A `claude` that does what Claude Code does, then leaves a settings file nobody can read in place of the real one. */
  function claudeThenBreakSettings(m: Machine, subcommand: string): string {
    const wrapper = join(dirname(m.log), 'claude-then-break');
    writeFileSync(wrapper, `#!/bin/sh\n'${m.target.claude}' "$@"\ns=$?\nif [ "$2" = '${subcommand}' ]; then rm -f '${m.settings}'; mkdir '${m.settings}'; fi\nexit $s\n`, { mode: 0o755 });
    return wrapper;
  }

  it('install says the server is registered but its hooks are not, and that installing again finishes it', async () => {
    const m = machine();
    seedUserConfig(m);
    const result = await installMcpIntegration({ ...m.target, claude: claudeThenBreakSettings(m, 'add-json') });
    expect({ result, registered: servers(m.state)['agent-terminal'] !== undefined }).toEqual({
      result: { ok: false, error: expect.stringMatching(/server was registered.*hooks were not written.*Install again/s) },
      registered: true,
    });
  });

  it('remove says the server is removed but its hooks are not, and that removing again finishes it', async () => {
    const m = machine();
    await seedInstalled(m);
    const result = await removeMcpIntegration({ ...m.target, claude: claudeThenBreakSettings(m, 'remove') });
    expect({ result, registered: servers(m.state)['agent-terminal'] !== undefined }).toEqual({
      result: { ok: false, error: expect.stringMatching(/server was removed.*hooks were not removed.*Remove again/s) },
      registered: false,
    });
  });
});

describe('running the same action again after it stopped part way', () => {
  const breakSettingsAfter = (m: Machine, subcommand: string): string => {
    const wrapper = join(dirname(m.log), 'claude-then-break-once');
    writeFileSync(wrapper, `#!/bin/sh\n'${m.target.claude}' "$@"\ns=$?\nif [ "$2" = '${subcommand}' ]; then rm -f '${m.settings}'; mkdir '${m.settings}'; fi\nexit $s\n`, { mode: 0o755 });
    return wrapper;
  };
  const restoreSettings = (m: Machine, settings: unknown): void => {
    rmSync(m.settings, { recursive: true, force: true });
    writeFileSync(m.settings, JSON.stringify(settings, null, 2));
  };

  it('finishes an install: the hooks are written, and the server is not registered a second time', async () => {
    const m = machine();
    seedUserConfig(m);
    const first = await installMcpIntegration({ ...m.target, claude: breakSettingsAfter(m, 'add-json') });
    restoreSettings(m, USER_SETTINGS);
    const again = await installMcpIntegration(m.target);
    expect({ first: first.ok, again, hookEvents: eventsRunning(m.settings, LAUNCH.command), registrations: claudeMcpRuns(m).filter((r) => r.startsWith('add-json')).length }).toEqual({
      first: false,
      again: { ok: true },
      hookEvents: GUARD_HOOK_EVENTS,
      registrations: 1,
    });
  });

  it("finishes a remove: the integration's hooks are taken out, leaving the operator's settings", async () => {
    const m = machine();
    await seedInstalled(m);
    const installedSettings = readJson(m.settings);
    const first = await removeMcpIntegration({ ...m.target, claude: breakSettingsAfter(m, 'remove') });
    restoreSettings(m, installedSettings);
    const again = await removeMcpIntegration(m.target);
    expect({ first: first.ok, again, settings: readJson(m.settings), registered: servers(m.state)['agent-terminal'] !== undefined }).toEqual({
      first: false,
      again: { ok: true },
      settings: USER_SETTINGS,
      registered: false,
    });
  });
});

describe("Claude Code's state file that cannot be read", () => {
  const breakings: [string, (m: Machine) => void][] = [
    ['holds invalid JSON', (m) => writeFileSync(m.state, '{ "mcpServers": ')],
    ['is a directory', (m) => { rmSync(m.state); mkdirSync(m.state); }],
  ];
  for (const [how, breakState] of breakings) {
    it(`fails install and remove naming it when it ${how}, writing nothing and running no claude mcp change`, async () => {
      const m = machine();
      await seedInstalled(m);
      breakState(m);
      const before = bytes(m.settings);
      const runsBefore = claudeMcpRuns(m).length;
      const installed = await installMcpIntegration(m.target);
      const removed = await removeMcpIntegration(m.target);
      expect({ installed, removed, settings: bytes(m.settings), newRuns: claudeMcpRuns(m).length - runsBefore }).toEqual({
        installed: { ok: false, error: expect.stringContaining(m.state) },
        removed: { ok: false, error: expect.stringContaining(m.state) },
        settings: before,
        newRuns: 0,
      });
    });
  }
});

describe("the settings file's permissions", () => {
  it('are kept when install and remove rewrite it, and are owner-only when install creates it', async () => {
    const kept = machine();
    seedUserConfig(kept);
    chmodSync(kept.settings, 0o640);
    await installMcpIntegration(kept.target);
    const afterInstall = statSync(kept.settings).mode & 0o777;
    await removeMcpIntegration(kept.target);
    const created = machine();
    await installMcpIntegration(created.target);
    expect({ afterInstall, afterRemove: statSync(kept.settings).mode & 0o777, created: statSync(created.settings).mode & 0o777 }).toEqual({ afterInstall: 0o640, afterRemove: 0o640, created: 0o600 });
  });
});

describe('removing the integration from a hook group it shares with an operator hook', () => {
  it("takes out only its own hook, leaving the operator's in that group", async () => {
    const m = machine();
    await seedInstalled(m);
    const shared = { ...USER_SETTINGS, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: `'${LAUNCH.command}' ${LAUNCH.args.join(' ')} --hook` }] }] } };
    writeFileSync(m.settings, JSON.stringify(shared, null, 2));
    const result = await removeMcpIntegration(m.target);
    expect({ result, settings: readJson(m.settings) }).toEqual({ result: { ok: true }, settings: USER_SETTINGS });
  });
});

describe.each(['install', 'remove'] as const)('%s with a non-regular configuration file', action => {
  it.each([
    ['state', 'with available bytes'], ['settings', 'with available bytes'],
    ['state', 'without a writer'], ['settings', 'without a writer'],
  ] as const)('refuses a FIFO %s %s, preserves configuration, and can retry after repair', async (which, mode) => {
    const m = machine();
    await seedInstalled(m);
    const file = m[which];
    const original = readFileSync(file, 'utf8');
    const otherFile = which === 'state' ? m.settings : m.state;
    const otherBefore = bytes(otherFile);
    rmSync(file);
    execFileSync('mkfifo', [file]);
    const writer = mode === 'with available bytes'
      ? spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "{")', file], { stdio: 'ignore' })
      : undefined;
    const exited = writer ? once(writer, 'exit') : undefined;
    const change = action === 'install' ? installMcpIntegration : removeMcpIntegration;
    try {
      const result = await change(m.target);
      expect(result).toEqual({ ok: false, error: expect.stringContaining('not a regular file') });
      if (!result.ok) expect(result.error).toContain(file);
      expect(lstatSync(file).isFIFO()).toBe(true);
      expect(bytes(otherFile)).toBe(otherBefore);
    } finally {
      writer?.kill();
      await exited;
    }
    rmSync(file);
    writeFileSync(file, original);
    expect(await change(m.target)).toEqual({ ok: true });
    expect(eventsRunning(m.settings, LAUNCH.command)).toEqual(action === 'install' ? GUARD_HOOK_EVENTS : []);
  });
});


describe('alternate Claude state locations', () => {
  it.each(['legacy', 'custom OAuth', 'legacy before custom OAuth'] as const)('%s supports repeated install and complete removal without touching the inactive state', async location => {
    const m = machine();
    seedUserConfig(m);
    const inactive = m.state;
    const before = bytes(inactive);
    m.state = join(m.root, location === 'custom OAuth' ? '.claude-custom-oauth.json' : '.config.json');
    if (location !== 'legacy') m.target.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://claude.fedstart.com';
    m.target.env.FAKE_CLAUDE_STATE_FILE = m.state;
    writeFileSync(m.state, JSON.stringify(USER_STATE));
    expect(await installMcpIntegration(m.target)).toEqual({ ok: true });
    const installed = files(m);
    expect(await installMcpIntegration(m.target)).toEqual({ ok: true });
    expect(files(m)).toEqual(installed);
    expect(servers(m.state)['agent-terminal']).toEqual({ type: 'stdio', ...LAUNCH });
    expect(await removeMcpIntegration(m.target)).toEqual({ ok: true });
    expect(readJson(m.state)).toEqual(USER_STATE);
    expect(readJson(m.settings)).toEqual(USER_SETTINGS);
    expect(bytes(inactive)).toBe(before);
  });

  it('removes an already installed legacy registration, preserving another server and unrelated settings', async () => {
    const m = machine();
    m.state = join(m.root, '.config.json');
    m.target.env.FAKE_CLAUDE_STATE_FILE = m.state;
    await seedInstalled(m);
    expect(await removeMcpIntegration(m.target)).toEqual({ ok: true });
    expect(readJson(m.state)).toEqual(USER_STATE);
    expect(readJson(m.settings)).toEqual(USER_SETTINGS);
  });

  it('keeps a same-named foreign legacy server intact on install and remove', async () => {
    const m = machine();
    m.state = join(m.root, '.config.json');
    m.target.env.FAKE_CLAUDE_STATE_FILE = m.state;
    seedUserConfig(m);
    writeFileSync(m.state, JSON.stringify({ mcpServers: { 'agent-terminal': { command: '/other/server' } } }));
    const before = files(m);
    expect(await installMcpIntegration(m.target)).toEqual({ ok: false, error: expect.stringContaining('/other/server') });
    expect(await removeMcpIntegration(m.target)).toEqual({ ok: true });
    expect(files(m)).toEqual(before);
  });
});

it.each(['install', 'remove'] as const)('%s does not claim success when Claude exits zero without applying the registration change', async action => {
  const m = machine();
  if (action === 'remove') await seedInstalled(m);
  else seedUserConfig(m);
  const before = files(m);
  const noop = join(dirname(m.log), 'claude-noop');
  writeFileSync(noop, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await (action === 'install' ? installMcpIntegration : removeMcpIntegration)({ ...m.target, claude: noop });
  expect(result).toEqual({ ok: false, error: expect.stringContaining(m.state) });
  expect(files(m)).toEqual(before);
});


it.each([false, true])('legacy registration under HOME works with CLAUDE_CONFIG_DIR unset (empty: %s)', async empty => {
  const m = machine();
  delete m.target.env.CLAUDE_CONFIG_DIR;
  m.root = join(m.target.env.HOME!, '.claude');
  m.settings = join(m.root, 'settings.json');
  m.state = join(m.root, '.config.json');
  m.target.env.FAKE_CLAUDE_STATE_FILE = m.state;
  seedUserConfig(m);
  if (empty) writeFileSync(m.state, '');
  expect(await installMcpIntegration(m.target)).toEqual({ ok: true });
  expect(servers(m.state)['agent-terminal']).toBeDefined();
  expect(await removeMcpIntegration(m.target)).toEqual({ ok: true });
  expect(servers(m.state)['agent-terminal']).toBeUndefined();
  expect(existsSync(join(m.target.env.HOME!, '.claude.json'))).toBe(false);
});

it('uses modern state when the legacy file is empty and modern state exists', async () => {
  const m = machine();
  seedUserConfig(m);
  const legacy = join(m.root, '.config.json');
  writeFileSync(legacy, '');
  expect(await installMcpIntegration(m.target)).toEqual({ ok: true });
  expect(servers(m.state)['agent-terminal']).toBeDefined();
  expect(bytes(legacy)).toBe('');
});
