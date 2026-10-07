import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  resolveExampleFlowsDir,
  resolveFeatureDevFlowDir,
  resolveExampleCommandsDir,
} from '../../src/main/exampleAssets';
import type { BundleLocation } from '../../src/main/bundleLocation';

// The bundled example assets must resolve in BOTH a dev run and a packaged build (§18.1) via an
// injected location, never a repo-relative path — the same dev-vs-packaged split appIcon uses.

describe('resolveFeatureDevFlowDir', () => {
  it('resolves to the feature-dev catalog entry in a packaged app', () => {
    expect(
      resolveFeatureDevFlowDir({ packaged: true, resourcesPath: '/app/resources' }),
    ).toBe(path.join('/app/resources', 'example', 'flows', 'feature-dev-v2'));
  });

  it('resolves to example/flows/feature-dev-v2 under the app path in an unpackaged build', () => {
    expect(
      resolveFeatureDevFlowDir({ packaged: false, appPath: '/out/main' }),
    ).toBe(path.join('/out/main', 'example', 'flows', 'feature-dev-v2'));
  });

  it('resolves to a real flow.yaml when the app path is a fixture root (no repo-relative path)', () => {
    // Point the resolver at a fixture root (as app.getAppPath() would) and prove the resolved dir holds
    // a real flow.yaml — the resolution contract, not a hardcoded example/ path.
    const fixtureRoot = path.resolve(__dirname, '..', '..'); // repo root standing in for appPath
    const dir = resolveFeatureDevFlowDir({ packaged: false, appPath: fixtureRoot });
    expect(readFileSync(path.join(dir, 'flow.yaml'), 'utf8')).toContain('name: feature-dev-v2\n');
  });
});

describe('resolveExampleCommandsDir', () => {
  it('resolves to the extraResources copy in a packaged app', () => {
    expect(
      resolveExampleCommandsDir({ packaged: true, resourcesPath: '/app/resources' }),
    ).toBe(path.join('/app/resources', 'example', 'commands'));
  });

  it('resolves to example/commands under the app path in an unpackaged build', () => {
    expect(
      resolveExampleCommandsDir({ packaged: false, appPath: '/out/main' }),
    ).toBe(path.join('/out/main', 'example', 'commands'));
  });

  it('resolves to the real bundled commands when the app path is a fixture root', () => {
    const fixtureRoot = path.resolve(__dirname, '..', '..');
    const dir = resolveExampleCommandsDir({ packaged: false, appPath: fixtureRoot });
    expect(existsSync(path.join(dir, 'groom-ticket.md'))).toBe(true);
  });
});

describe('the bundled command tree is a sibling of the flow tree, never nested inside it', () => {
  // The flow install set is flow.yaml + todo-templates/*.md (§18.6). A command living under the flow
  // bundle would be silently un-seeded by the flow destination and double-owned by the commands one.
  it('carries no commands/ subtree inside the feature-dev flow home', () => {
    const fixtureRoot = path.resolve(__dirname, '..', '..');
    const flowDir = resolveFeatureDevFlowDir({ packaged: false, appPath: fixtureRoot });
    expect(existsSync(path.join(flowDir, 'commands'))).toBe(false);
  });
});

describe('extraResources packaged-path coupling', () => {
  const root = path.resolve(__dirname, '..', '..');
  const builderYml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const RESOURCES = '/app/resources';
  const packaged: BundleLocation = { packaged: true, resourcesPath: RESOURCES };

  // Coupling: the build writes each tree to a `to:` literal and the runtime reads it back through a
  // resolver, and no type binds the two (CLAUDE.md writer↔reader rule — pin it with a test). The
  // expected `to:` is DERIVED from the resolver, never re-spelled: an assertion that hard-codes
  // `to: example/flows` stays green when the resolver is renamed and the packaged app breaks. The flow
  // entry pins the shipped `flows` tree (resolveExampleFlowsDir); the global-fallback source
  // (resolveFeatureDevFlowDir) reaches the builder transitively as its feature-dev entry, so pinning
  // that subpath would assert a `to:` the builder does not ship.
  for (const [tree, resolve] of [
    ['flows', resolveExampleFlowsDir],
    ['commands', resolveExampleCommandsDir],
  ] as const) {
    it(`ships example/${tree} under the exact path its packaged resolver reads back`, () => {
      const to = path.relative(RESOURCES, resolve(packaged));
      expect(builderYml).toMatch(new RegExp(`from:\\s*example/${tree}\\b`));
      expect(builderYml).toMatch(new RegExp(`to:\\s*${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
    });
  }
});
