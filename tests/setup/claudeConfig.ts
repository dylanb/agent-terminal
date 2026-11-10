import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inherited = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ZDOTDIR: process.env.ZDOTDIR,
};
const home = mkdtempSync(join(tmpdir(), 'atv-'));
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ZDOTDIR: home });

afterAll(() => {
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
