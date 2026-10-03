import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyExampleFlows, copyExampleLoopsV2, copyExampleCommands } from '../../src/main/exampleAssetsBuild';
import {
  resolveExampleFlowsDir,
  resolveExampleLoopsV2Dir,
  resolveExampleCommandsDir,
} from '../../src/main/exampleAssets';

// The unpackaged runtime resolvers read <app.getAppPath()>/example/<tree>, and app.getAppPath() is the
// main out dir for a built (non-packaged) run — but nothing puts those trees there. Each build copy must
// land its committed tree exactly where its resolver reads it; reusing the resolver keeps them aligned.

let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ex-root-'));
  out = mkdtempSync(path.join(tmpdir(), 'ex-out-'));

  const flowDir = path.join(root, 'example', 'flows', 'feature-dev');
  mkdirSync(path.join(flowDir, 'todo-templates'), { recursive: true });
  writeFileSync(path.join(flowDir, 'flow.yaml'), 'name: feature-dev\nsteps: []\n');
  writeFileSync(path.join(flowDir, 'todo-templates', 'a.md'), '# A\n- one\n');

  const cmdDir = path.join(root, 'example', 'commands');
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(path.join(cmdDir, 'groom-ticket.md'), '# groom\n');

  const v2Dir = path.join(root, 'example', 'loops-v2', 'plan-loop');
  mkdirSync(path.join(v2Dir, 'charter'), { recursive: true });
  writeFileSync(path.join(v2Dir, 'plan-loop.yaml'), 'version: v2\nname: plan-loop\n');
  writeFileSync(path.join(v2Dir, 'charter', 'principal.md'), '# principal\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe('copyExampleFlows — places the catalog bundle where the unpackaged resolver reads it', () => {
  it('copies example/flows to the path resolveExampleFlowsDir reads for that out dir', () => {
    const dest = copyExampleFlows(root, out);
    expect(dest).toBe(resolveExampleFlowsDir({ packaged: false, appPath: out }));
    expect(readFileSync(path.join(dest, 'feature-dev', 'flow.yaml'), 'utf8')).toContain('name: feature-dev');
  });

  it('copies the whole todo-templates subtree, creating the destination dir', () => {
    expect(existsSync(path.join(out, 'example', 'flows'))).toBe(false);
    copyExampleFlows(root, out);
    expect(readFileSync(path.join(out, 'example', 'flows', 'feature-dev', 'todo-templates', 'a.md'), 'utf8')).toContain('# A');
  });
});

describe('copyExampleLoopsV2 — places the bundled §27 tree where the unpackaged resolver reads it', () => {
  it('copies example/loops-v2 to the path resolveExampleLoopsV2Dir reads for that out dir', () => {
    const dest = copyExampleLoopsV2(root, out);
    expect(dest).toBe(resolveExampleLoopsV2Dir({ packaged: false, appPath: out }));
    expect(readFileSync(path.join(dest, 'plan-loop', 'plan-loop.yaml'), 'utf8')).toContain('version: v2');
    expect(readFileSync(path.join(dest, 'plan-loop', 'charter', 'principal.md'), 'utf8')).toContain('# principal');
  });
});

describe('copyExampleCommands — places the bundled commands where the unpackaged resolver reads them', () => {
  it('copies example/commands to the path resolveExampleCommandsDir reads for that out dir', () => {
    const dest = copyExampleCommands(root, out);
    expect(dest).toBe(resolveExampleCommandsDir({ packaged: false, appPath: out }));
    expect(readFileSync(path.join(dest, 'groom-ticket.md'), 'utf8')).toContain('# groom');
  });

  it('creates the destination dir when it does not exist', () => {
    expect(existsSync(path.join(out, 'example', 'commands'))).toBe(false);
    copyExampleCommands(root, out);
    expect(existsSync(path.join(out, 'example', 'commands'))).toBe(true);
  });
});

describe('a symlink in a committed bundle tree fails the build — it is never followed into the bundle (CWE-59)', () => {
  // The install-time walker deliberately SKIPS a symlink rather than reading through it. But the
  // build-time copier runs FIRST: `copyFileSync` follows a link and materializes the target's bytes as a
  // regular file, so by the time the installer walks the bundle there is no symlink left to skip — the
  // outside content has already been laundered into it, and lands in the user's ~/.claude on install.
  // A link in a committed tree is a repo defect, so it fails the build loudly.
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(path.join(tmpdir(), 'ex-outside-'));
    writeFileSync(path.join(outside, 'secret.md'), 'not part of the bundle\n');
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a symlinked FILE planted in example/commands', () => {
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'example', 'commands', 'linked.md'));
    expect(() => copyExampleCommands(root, out)).toThrow(/symbolic link|symlink/i);
    expect(existsSync(path.join(out, 'example', 'commands', 'linked.md'))).toBe(false);
  });

  it('refuses a symlinked DIRECTORY planted in example/loops-v2', () => {
    mkdirSync(path.join(outside, 'secret-dir'), { recursive: true });
    writeFileSync(path.join(outside, 'secret-dir', 'nested.md'), 'nor is this\n');
    symlinkSync(path.join(outside, 'secret-dir'), path.join(root, 'example', 'loops-v2', 'linked-dir'));
    expect(() => copyExampleLoopsV2(root, out)).toThrow(/symbolic link|symlink/i);
    expect(existsSync(path.join(out, 'example', 'loops-v2', 'linked-dir'))).toBe(false);
  });

  it('does not launder the link target into the bundle as a regular file', () => {
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'example', 'flows', 'feature-dev', 'linked.md'));
    expect(() => copyExampleFlows(root, out)).toThrow();
    expect(existsSync(path.join(out, 'example', 'flows', 'feature-dev', 'linked.md'))).toBe(false);
  });
});
