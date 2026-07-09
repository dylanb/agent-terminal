import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// §24.2.3 T4 — macOS authorizes an app for notifications only when its signature BINDS its Info.plist
// and its code-signing identifier is the bundle id. A linker-signed bundle (what Electron ships, and
// what electron-builder emits with no identity) reports `Identifier=Electron` / `Info.plist=not bound`,
// and every Notification.show() then fails with UNErrorDomain 1. The observable this asserts is exactly
// the pair macOS reads. Darwin-only: `codesign` is the system under test.
const darwin = process.platform === 'darwin';

const SCRIPT = join(__dirname, '../../scripts/sign-bundle.sh');

/** A real, minimal, signable .app: a Mach-O executable (a copy of a system binary) plus an Info.plist. */
function makeBundle(dir: string, bundleId: string): string {
  const app = join(dir, 'Probe.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  copyFileSync('/bin/echo', join(app, 'Contents', 'MacOS', 'Probe'));
  chmodSync(join(app, 'Contents', 'MacOS', 'Probe'), 0o755);
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>Probe</string>\n<key>CFBundleIdentifier</key><string>${bundleId}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n</dict></plist>\n`,
  );
  return app;
}

/** `codesign -dv` reports on stderr, and exits non-zero for an unsigned bundle. */
function inspect(app: string): string {
  return execFileSync('/bin/sh', ['-c', `codesign -dv '${app}' 2>&1 || true`], { encoding: 'utf8' });
}

const run = (app: string, bundleId: string): void => {
  execFileSync('/bin/bash', [SCRIPT, app, bundleId], { encoding: 'utf8' });
};

describe.skipIf(!darwin)('ad-hoc bundle signing so macOS will deliver notifications (§24.2.3 T4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signbundle-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves an unsigned-by-the-linker bundle reporting a foreign identifier and an unbound Info.plist', () => {
    const app = makeBundle(dir, 'dev.agentterminal.app');
    const before = inspect(app);
    expect(before).toContain('Info.plist=not bound');
    expect(before).not.toContain('Identifier=dev.agentterminal.app');
  });

  it('binds the Info.plist and adopts the bundle id as the code-signing identifier', () => {
    const app = makeBundle(dir, 'placeholder.id');

    run(app, 'dev.agentterminal.app');

    const after = inspect(app);
    expect(after).toContain('Identifier=dev.agentterminal.app');
    expect(after).not.toContain('Info.plist=not bound');
  });

  it('is idempotent — re-running over an already-signed bundle leaves the identifier intact', () => {
    const app = makeBundle(dir, 'placeholder.id');
    run(app, 'dev.agentterminal.app');
    run(app, 'dev.agentterminal.app');
    expect(inspect(app)).toContain('Identifier=dev.agentterminal.app');
  });

  it('succeeds silently when the bundle is absent, so it can never fail an install', () => {
    expect(() => run(join(dir, 'Missing.app'), 'dev.agentterminal.app')).not.toThrow();
  });
});
