import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyExampleFlow, copyExampleLoops, copyExampleLoopsV2, copyExampleCommands } from '../../src/main/exampleAssetsBuild';
import {
  resolveExampleFlowDir,
  resolveExampleLoopsDir,
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

  const flowDir = path.join(root, 'example', 'flow');
  mkdirSync(path.join(flowDir, 'todo-templates'), { recursive: true });
  writeFileSync(path.join(flowDir, 'flow.yaml'), 'name: feature-dev\nsteps: []\n');
  writeFileSync(path.join(flowDir, 'todo-templates', 'a.md'), '# A\n- one\n');

  const loopDir = path.join(root, 'example', 'loops', 'plan-loop');
  mkdirSync(path.join(loopDir, 'prompts'), { recursive: true });
  mkdirSync(path.join(loopDir, 'skills', 'review-intent'), { recursive: true });
  writeFileSync(path.join(loopDir, 'plan-loop.yaml'), 'name: plan-loop\n');
  writeFileSync(path.join(loopDir, 'prompts', 'work-plan.md'), '# work\n');
  writeFileSync(path.join(loopDir, 'skills', 'review-intent', 'SKILL.md'), '# intent\n');

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

describe('copyExampleFlow — places the bundle where the unpackaged resolver reads it', () => {
  it('copies example/flow to the path resolveExampleFlowDir reads for that out dir', () => {
    const dest = copyExampleFlow(root, out);
    expect(dest).toBe(resolveExampleFlowDir({ packaged: false, appPath: out }));
    expect(readFileSync(path.join(dest, 'flow.yaml'), 'utf8')).toContain('name: feature-dev');
  });

  it('copies the whole todo-templates subtree, creating the destination dir', () => {
    expect(existsSync(path.join(out, 'example', 'flow'))).toBe(false);
    copyExampleFlow(root, out);
    expect(readFileSync(path.join(out, 'example', 'flow', 'todo-templates', 'a.md'), 'utf8')).toContain('# A');
  });
});

describe('copyExampleLoops — places the bundled definitions where the unpackaged resolver reads them', () => {
  it('copies example/loops to the path resolveExampleLoopsDir reads for that out dir', () => {
    const dest = copyExampleLoops(root, out);
    expect(dest).toBe(resolveExampleLoopsDir({ packaged: false, appPath: out }));
    expect(readFileSync(path.join(dest, 'plan-loop', 'plan-loop.yaml'), 'utf8')).toContain('name: plan-loop');
  });

  it('copies every file bundled with a definition — prompts and nested skills alike (§26.5)', () => {
    const dest = copyExampleLoops(root, out);
    expect(readFileSync(path.join(dest, 'plan-loop', 'prompts', 'work-plan.md'), 'utf8')).toContain('# work');
    expect(readFileSync(path.join(dest, 'plan-loop', 'skills', 'review-intent', 'SKILL.md'), 'utf8')).toContain('# intent');
  });

  // Skills fan into one shared root at install time (§26.5); two loops shipping the same skill name would
  // silently collapse there. The build refuses to ship such a bundle, naming the offenders.
  it('refuses to copy a loops tree where two definitions ship the same skill name', () => {
    const other = path.join(root, 'example', 'loops', 'impl-loop', 'skills', 'review-intent');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'SKILL.md'), '# duplicate intent\n');

    expect(() => copyExampleLoops(root, out)).toThrow(/review-intent/);
    expect(() => copyExampleLoops(root, out)).toThrow(/plan-loop/);
    expect(() => copyExampleLoops(root, out)).toThrow(/impl-loop/);
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
  // A link in a committed tree is a repo defect, so it fails the build loudly, exactly as a colliding
  // skill name does.
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

  it('refuses a symlinked DIRECTORY planted in example/loops', () => {
    mkdirSync(path.join(outside, 'secret-dir'), { recursive: true });
    writeFileSync(path.join(outside, 'secret-dir', 'nested.md'), 'nor is this\n');
    symlinkSync(path.join(outside, 'secret-dir'), path.join(root, 'example', 'loops', 'linked-dir'));
    expect(() => copyExampleLoops(root, out)).toThrow(/symbolic link|symlink/i);
    expect(existsSync(path.join(out, 'example', 'loops', 'linked-dir'))).toBe(false);
  });

  it('does not launder the link target into the bundle as a regular file', () => {
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'example', 'flow', 'linked.md'));
    expect(() => copyExampleFlow(root, out)).toThrow();
    expect(existsSync(path.join(out, 'example', 'flow', 'linked.md'))).toBe(false);
  });
});
