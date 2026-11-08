import { afterEach, describe, expect, it } from 'vitest';
import { shellQuote } from '../../src/shared/shellQuote';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findClaude } from '../../src/main/mcpInstall';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-find-claude-')));
  dirs.push(dir);
  return dir;
}

function executable(dir: string, name: string, body = 'exit 0'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The user's shell as macOS's terminal starts it, interactive and login, whose startup files put `claude` at `found`, `loginPath` on PATH and, when given,
 *  export `configDir` as CLAUDE_CONFIG_DIR: it runs the command it is given in that environment, where
 *  `command -v claude` answers `found`, after printing the noise an interactive startup can print. */
function loginShellFinding(found: string | null, loginPath: string, configDir?: string): string {
  const dir = temp();
  const bin = join(dir, 'login-bin');
  mkdirSync(bin);
  if (found !== null) writeFileSync(join(bin, 'command-v-claude'), `#!/bin/sh\nprintf '%s\\n' '${found}'\n`, { mode: 0o755 });
  const shell = join(dir, 'login-shell');
  const exportConfig = configDir === undefined ? '' : `CLAUDE_CONFIG_DIR='${configDir}'\nexport CLAUDE_CONFIG_DIR\n`;
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 2\necho 'Welcome back!'\ncommand() { [ -x '${join(bin, 'command-v-claude')}' ] && '${join(bin, 'command-v-claude')}'; }\nPATH='${loginPath}'\n${exportConfig}eval "$4"\n`,
    { mode: 0o755 },
  );
  return shell;
}

describe('finding the Claude Code the install action runs', () => {
  it("is the claude on the app's PATH, else the one the user's interactive login shell finds, run with that shell's PATH and Claude Code config, else none", async () => {
    const root = temp();
    const onPath = executable(join(root, 'path-bin'), 'claude');
    const viaLogin = executable(join(root, 'login-bin'), 'claude');
    const empty = join(root, 'empty-bin');
    mkdirSync(empty);
    expect({
      onPath: await findClaude('darwin', { PATH: `${empty}:${join(root, 'path-bin')}`, SHELL: loginShellFinding(viaLogin, '/login/node/bin') }),
      loginShell: await findClaude('darwin', { PATH: empty, SHELL: loginShellFinding(viaLogin, '/login/node/bin', '/login/claude-config') }),
      none: await findClaude('darwin', { PATH: empty, SHELL: loginShellFinding(null, '/login/node/bin') }),
    }).toEqual({
      onPath: { claude: onPath, path: `${empty}:${join(root, 'path-bin')}:/login/node/bin` },
      loginShell: { claude: viaLogin, path: `${empty}:/login/node/bin`, claudeConfigDir: '/login/claude-config' },
      none: null,
    });
  });

  it('never takes a claude from a relative PATH entry or a login-shell answer that is not a path, nor runs it with a relative PATH entry', async () => {
    const root = temp();
    const viaLogin = executable(join(root, 'login-bin'), 'claude');
    executable(join(root, 'relative-bin'), 'claude');
    const aliasShell = join(temp(), 'alias-shell');
    writeFileSync(aliasShell, `#!/bin/sh\ncommand() { echo '${relative(process.cwd(), viaLogin)}'; }\neval "$4"\n`, { mode: 0o755 });
    expect({
      relativeOnPath: await findClaude('darwin', { PATH: relative(process.cwd(), join(root, 'relative-bin')), SHELL: loginShellFinding(viaLogin, '/login/node/bin') }),
      relativeFromLogin: await findClaude('darwin', { PATH: join(root, 'empty'), SHELL: aliasShell }),
    }).toEqual({
      relativeOnPath: { claude: viaLogin, path: '/login/node/bin' },
      relativeFromLogin: null,
    });
  });

  it("settles when the user's shell never finishes starting, still finding the claude on the app's PATH", async () => {
    const root = temp();
    const onPath = executable(join(root, 'path-bin'), 'claude');
    const stuckDir = temp();
    const alive = join(stuckDir, 'alive');
    writeFileSync(alive, '');
    const stuck = join(stuckDir, 'stuck-shell');
    writeFileSync(stuck, `#!/bin/sh\ntrap "" TERM\nwhile [ -e ${shellQuote(alive)} ]; do /bin/sleep 0.1; done\n`, { mode: 0o755 });
    expect(await findClaude('darwin', { PATH: join(root, 'path-bin'), SHELL: stuck }, { shellTimeoutMs: 200 })).toEqual({ claude: onPath, path: join(root, 'path-bin') });
  }, 20_000);

  it("asks the shell as the window's terminal starts it on each platform: a login shell on macOS, not one on Linux", async () => {
    const root = temp();
    const fromProfile = executable(join(root, 'profile-bin'), 'claude');
    const fromRc = executable(join(root, 'rc-bin'), 'claude');
    const shell = join(temp(), 'shell');
    writeFileSync(
      shell,
      `#!/bin/sh\nif [ "$1" = "-l" ]; then PATH='${join(root, 'profile-bin')}'; shift; else PATH='${join(root, 'rc-bin')}'; fi\n[ "$1" = "-i" ] && [ "$2" = "-c" ] || exit 2\neval "$3"\n`,
      { mode: 0o755 },
    );
    const env = { PATH: join(root, 'empty'), SHELL: shell };
    expect({ darwin: (await findClaude('darwin', env))?.claude, linux: (await findClaude('linux', env))?.claude }).toEqual({ darwin: fromProfile, linux: fromRc });
  });
});
