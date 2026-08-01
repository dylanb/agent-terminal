import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandFailure, run } from '../../src/main/appBootstrapCommand';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('run', () => {
  it('resolves with the stdout of a successful command', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-run-'));
    cleanup.push(bin);
    const probe = join(bin, 'probe');
    writeFileSync(probe, '#!/usr/bin/env bash\nprintf \'ok\\n\'\n', { mode: 0o755 });

    await expect(run(probe, [], bin, 'probe failed')).resolves.toBe('ok\n');
  });

  it('rejects with a CommandFailure carrying the exit code on a failing command', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-run-fail-'));
    cleanup.push(bin);
    const probe = join(bin, 'probe');
    writeFileSync(probe, '#!/usr/bin/env bash\nexit 7\n', { mode: 0o755 });

    const failure: unknown = await run(probe, [], bin, 'probe failed').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).message).toBe('probe failed (exit 7)');
    expect((failure as CommandFailure).exitCode).toBe(7);
  });
});
