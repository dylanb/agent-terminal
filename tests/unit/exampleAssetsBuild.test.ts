import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyExampleFlow } from '../../src/main/exampleAssetsBuild';
import { resolveExampleFlowDir } from '../../src/main/exampleAssets';

// The unpackaged runtime resolver reads <app.getAppPath()>/example/flow, and app.getAppPath() is the
// main out dir for a built (non-packaged) run — but nothing put the tree there. The build copy must land
// the committed example flow exactly where the resolver reads it; reusing the resolver keeps them aligned.
describe('copyExampleFlow — places the bundle where the unpackaged resolver reads it', () => {
  let root: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ex-root-'));
    out = mkdtempSync(path.join(tmpdir(), 'ex-out-'));
    const flowDir = path.join(root, 'example', 'flow');
    mkdirSync(path.join(flowDir, 'todo-templates'), { recursive: true });
    writeFileSync(path.join(flowDir, 'flow.yaml'), 'name: feature-dev\nsteps: []\n');
    writeFileSync(path.join(flowDir, 'todo-templates', 'a.md'), '# A\n- one\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('copies example/flow to the path resolveExampleFlowDir reads for that out dir', () => {
    const dest = copyExampleFlow(root, out);
    expect(dest).toBe(resolveExampleFlowDir({ packaged: false, resourcesPath: '', appPath: out }));
    expect(readFileSync(path.join(dest, 'flow.yaml'), 'utf8')).toContain('name: feature-dev');
  });

  it('copies the whole todo-templates subtree, creating the destination dir', () => {
    expect(existsSync(path.join(out, 'example', 'flow'))).toBe(false);
    copyExampleFlow(root, out);
    expect(readFileSync(path.join(out, 'example', 'flow', 'todo-templates', 'a.md'), 'utf8')).toContain('# A');
  });
});
