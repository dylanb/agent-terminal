import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLegacy } from '../../src/main/appBootstrapCommand';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalSshCommand = process.env.GIT_SSH_COMMAND;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = originalSshCommand;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

// §27.15 — "The old engine is never modified, only routed around. No §26 code is edited to accommodate
// §27." The module split that moved this runner out of bootstrapPorts.ts was a verbatim relocation, so
// the live §26 pickup path must still see the operator's environment. Hardening §26 is a deliberate
// change in its own right, with its own departure entry; it is not something a refactor does silently.
describe('legacy §26 pickup runner', () => {
  it('leaves the operator environment as the old engine had it', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-legacy-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "${GIT_SSH_COMMAND-unset}"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GIT_SSH_COMMAND = 'ssh -i /home/operator/.ssh/deploy_key';

    await expect(runLegacy('git', [], bin)).resolves.toBe(
      'ssh -i /home/operator/.ssh/deploy_key\n',
    );
  });
});
