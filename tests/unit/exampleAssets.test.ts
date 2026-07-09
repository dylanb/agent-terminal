import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveExampleFlowDir } from '../../src/main/exampleAssets';

// The bundled example flow must resolve in BOTH a dev run and a packaged build (§18.1) via an injected
// location, never a repo-relative path — the same dev-vs-packaged split appIcon uses.

describe('resolveExampleFlowDir', () => {
  it('resolves to the extraResources copy in a packaged app', () => {
    expect(
      resolveExampleFlowDir({ packaged: true, resourcesPath: '/app/resources', appPath: '/app/app.asar' }),
    ).toBe(path.join('/app/resources', 'example', 'flow'));
  });

  it('resolves to example/flow under the app path in an unpackaged build', () => {
    expect(
      resolveExampleFlowDir({ packaged: false, resourcesPath: '/ignored', appPath: '/out/main' }),
    ).toBe(path.join('/out/main', 'example', 'flow'));
  });

  it('resolves to a real flow.yaml when the app path is a fixture root (no repo-relative path)', () => {
    // Point the resolver at a fixture root (as app.getAppPath() would) and prove the resolved dir holds
    // a real flow.yaml — the resolution contract, not a hardcoded example/ path.
    const fixtureRoot = path.resolve(__dirname, '..', '..'); // repo root standing in for appPath
    const dir = resolveExampleFlowDir({ packaged: false, resourcesPath: '', appPath: fixtureRoot });
    expect(readFileSync(path.join(dir, 'flow.yaml'), 'utf8')).toContain('name: feature-dev');
  });
});

describe('extraResources packaged-path coupling', () => {
  const root = path.resolve(__dirname, '..', '..');
  const builderYml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

  it('ships example/flow under the path the packaged resolver reads back', () => {
    // Coupling: renaming either the electron-builder `to:` target or the packaged resolver segment
    // breaks the runtime bundle, and no type catches it — this test is the guard.
    expect(builderYml).toMatch(/from:\s*example\/flow\b/);
    expect(builderYml).toMatch(/to:\s*example\/flow\b/);
  });
});
