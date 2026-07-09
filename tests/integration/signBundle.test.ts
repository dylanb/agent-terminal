import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// The signing is darwin-only, but `postinstall` runs on EVERY platform's install. Invoking `bash` there
// unconditionally makes a non-mac `pnpm install` fail before the script's own platform guard can run, on
// any environment lacking bash. The install step must therefore never invoke bash unconditionally — the
// darwin gate belongs in node (always present in postinstall), not in the shell script it would launch.
describe('postinstall never requires bash off darwin (§24.2.3 T4 portability)', () => {
  it('gates the sign-bundle invocation in node, not behind a bare bash call', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const postinstall = pkg.scripts.postinstall;
    expect(postinstall).not.toMatch(/(^|&&|;|\|)\s*bash\b/);
    expect(postinstall).toContain('node scripts/postinstall-sign.mjs');
  });
});

describe.skipIf(!darwin)('ad-hoc bundle signing so macOS will deliver notifications (§24.2.3 T4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signbundle-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('binds the Info.plist and adopts the bundle id as the code-signing identifier', () => {
    const app = makeBundle(dir, 'placeholder.id');
    const before = inspect(app);
    expect(before).toContain('Info.plist=not bound');
    expect(before).not.toContain('Identifier=dev.agentterminal.app');

    run(app, 'dev.agentterminal.app');

    const after = inspect(app);
    expect(after).toContain('Identifier=dev.agentterminal.app');
    expect(after).not.toContain('Info.plist=not bound');
  });

  // The identifier macOS matches the notification authorization against IS the bundle id. Spelling it a
  // second time in the script lets `appId` be renamed while dev-mode signing keeps using the old one —
  // silently restoring "the notification was never delivered", whose diagnosis cost a 2x2 isolation.
  it('defaults the bundle id to electron-builder.yml appId, not a second copy of the literal', () => {
    const appId = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8').match(/^appId:\s*(\S+)/m)![1];
    const app = makeBundle(dir, 'placeholder.id');

    execFileSync('/bin/bash', [SCRIPT, app], { encoding: 'utf8' });

    expect(inspect(app)).toContain(`Identifier=${appId}`);
  });

  // Apple documents `--deep` as unsuitable for signing (TN3161): it re-signs every nested framework and
  // helper with this identity, discarding their real signatures. Only the top-level signature binds the
  // Info.plist, so nothing is gained by reaching inside.
  it('leaves a nested framework\'s existing signature untouched', () => {
    const app = makeBundle(dir, 'placeholder.id');
    const nested = join(app, 'Contents', 'Frameworks', 'Nested.framework');
    mkdirSync(nested, { recursive: true });
    copyFileSync('/bin/echo', join(nested, 'Nested'));
    chmodSync(join(nested, 'Nested'), 0o755);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'nested.original', nested]);
    const before = inspect(nested);

    run(app, 'dev.agentterminal.app');

    expect(inspect(nested)).toBe(before);
    expect(inspect(nested)).toContain('Identifier=nested.original');
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
