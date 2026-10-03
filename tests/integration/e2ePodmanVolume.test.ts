import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Each harness run installs and force-rebuilds native modules into its node_modules volume, so two checkouts
// running the e2e at once must never share one: a run that rebuilds node-pty under another run's live
// Electron launches leaves those windows never opening (a firstWindow timeout that reads as a flaky test).
const HARNESS = resolve(__dirname, '..', '..', 'scripts', 'e2e-podman.sh');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): { checkout: (name: string) => string; podmanLog: string; binDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'e2e-podman-volume-'));
  roots.push(root);
  const binDir = join(root, 'bin');
  const podmanLog = join(root, 'podman.log');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'podman'),
    `#!/usr/bin/env bash\necho "$*" >> "${podmanLog}"\n[ "$1 $2" = "machine inspect" ] && echo 16384\nexit 0\n`,
  );
  chmodSync(join(binDir, 'podman'), 0o755);
  writeFileSync(podmanLog, '');
  const checkout = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(HARNESS, join(dir, 'scripts', 'e2e-podman.sh'));
    return dir;
  };
  return { checkout, podmanLog, binDir };
}

const volumeOf = (checkout: string, binDir: string): string =>
  execFileSync('bash', [join(checkout, 'scripts', 'e2e-podman.sh')], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, E2E_PRINT_VOLUME: '1' },
    encoding: 'utf8',
  }).trim();

describe('e2e Podman harness — node_modules volume per checkout', () => {
  it('gives two checkouts different volumes, each stable across runs, without building or running', () => {
    const { checkout, podmanLog, binDir } = fixture();
    const a = checkout('worktree-a');
    const b = checkout('worktree-b');

    const volA = volumeOf(a, binDir);
    expect(volA).toMatch(/^agent-terminal-e2e-node_modules-[a-zA-Z0-9_.-]+$/);
    expect(volumeOf(a, binDir)).toBe(volA);
    expect(volumeOf(b, binDir)).not.toBe(volA);
    expect(readFileSync(podmanLog, 'utf8')).not.toMatch(/^(build|run)\b/m);
  });
});
