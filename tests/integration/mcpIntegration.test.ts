import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeClaudeCodeIntegration } from '../../src/main/mcpIntegration';
import { readFakeClaudeLog, seedFakeClaude } from '../helpers/fakeClaudeHarness';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function machine() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-mcp-integration-')));
  dirs.push(base);
  const bin = join(base, 'bin');
  const appHome = join(base, 'app-home');
  const config = join(base, 'claude-config');
  mkdirSync(bin);
  mkdirSync(appHome);
  seedFakeClaude(bin);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: config };
  return { base, appHome, config, ctx: { appHome, invocation: { execPath: process.execPath, appArgs: ['mcp.js'] }, env, platform: 'darwin' as const } };
}

const servers = (config: string): Record<string, unknown> =>
  existsSync(join(config, '.claude.json')) ? (JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')).mcpServers ?? {}) : {};

describe("the window's Claude Code integration actions", () => {
  it('remove takes the integration out even when the launcher can no longer be written', async () => {
    const m = machine();
    const installed = await changeClaudeCodeIntegration('install', m.ctx);
    const launcherDir = join(m.appHome, '.agent-terminal', 'claude-code');
    rmSync(launcherDir, { recursive: true, force: true });
    mkdirSync(join(m.base, 'elsewhere'));
    symlinkSync(join(m.base, 'elsewhere'), launcherDir);
    const removed = await changeClaudeCodeIntegration('remove', m.ctx);
    expect({ installed, removed, server: servers(m.config)['agent-terminal'] }).toEqual({ installed: { ok: true }, removed: { ok: true }, server: undefined });
  });

  it('fails saying Claude Code was not found when no claude is found, writing nothing', async () => {
    const m = machine();
    const result = await changeClaudeCodeIntegration('install', { ...m.ctx, env: { ...m.ctx.env, PATH: join(m.base, 'nowhere'), SHELL: '/bin/false' } });
    expect({ result, configCreated: existsSync(m.config) }).toEqual({ result: { ok: false, error: expect.stringContaining('Claude Code was not found') }, configCreated: false });
  });

  it("installs into the Claude Code configuration the user's shell sets, where the window's sessions read it", async () => {
    const m = machine();
    const shellConfig = join(m.base, 'shell-claude-config');
    const shell = join(m.base, 'login-shell');
    writeFileSync(shell, `#!/bin/sh\nCLAUDE_CONFIG_DIR='${shellConfig}'\nexport CLAUDE_CONFIG_DIR\nfor last; do :; done\neval "$last"\n`, { mode: 0o755 });
    const result = await changeClaudeCodeIntegration('install', { ...m.ctx, env: { ...m.ctx.env, SHELL: shell } });
    expect({ result, server: servers(shellConfig)['agent-terminal'] !== undefined, appConfigCreated: existsSync(m.config) }).toEqual({
      result: { ok: true },
      server: true,
      appConfigCreated: false,
    });
  });

  it('install fails saying the launcher could not be written, running nothing and writing nothing', async () => {
    const m = machine();
    mkdirSync(join(m.appHome, '.agent-terminal'));
    mkdirSync(join(m.base, 'elsewhere'));
    symlinkSync(join(m.base, 'elsewhere'), join(m.appHome, '.agent-terminal', 'claude-code'));
    const result = await changeClaudeCodeIntegration('install', m.ctx);
    const log = join(m.base, 'bin', 'fake-claude.log');
    expect({ result, configCreated: existsSync(m.config), claudeRuns: existsSync(log) ? readFakeClaudeLog(log).length : 0 }).toEqual({
      result: { ok: false, error: expect.stringContaining('launcher') },
      configCreated: false,
      claudeRuns: 0,
    });
  });
});
