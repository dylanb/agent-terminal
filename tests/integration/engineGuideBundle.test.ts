import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInstallExamplesCoordinator, exampleInstallDirs } from '../../src/main/installExamples';
import { resolveEngineGuideFile } from '../../src/main/exampleAssets';
import { buildBundleIn } from '../helpers/builtBundle';
import { SESSION_ID } from '../../src/shared/ipc';

let scratch: string;
let bundle: string;
let osHome: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'engine-guide-bundle-'));
  osHome = path.join(scratch, 'home');
  mkdirSync(osHome);
  bundle = buildBundleIn(scratch);
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const bundledGuide = (): string => resolveEngineGuideFile({ packaged: false, appPath: bundle });
const preview = () =>
  createInstallExamplesCoordinator(() =>
    exampleInstallDirs({ packaged: false, appPath: bundle }, { flowGlobalDir: osHome, configDir: path.join(scratch, 'claude'), codexHome: path.join(osHome, '.codex') }),
  ).preview({ sessionId: SESSION_ID });
/** The preview's refusal reason, or `'previewed'` when it was not refused. */
const refusal = (): string => {
  const p = preview();
  return p.ok ? 'previewed' : p.error;
};

describe('a bundle that does not carry the built guide is refused, never installed as nothing (#276)', () => {
  it('previews the intact bundle', () => {
    expect(refusal()).toBe('previewed');
  });

  it('refuses the preview, naming the guide’s destination, when the guide is missing from the bundle', () => {
    rmSync(bundledGuide());
    expect(refusal()).toContain('engineGuide');
  });

  it('refuses the preview, naming the bundled guide, when a symbolic link stands where it is', () => {
    const elsewhere = path.join(scratch, 'elsewhere.md');
    writeFileSync(elsewhere, '# Not the built guide\n');
    rmSync(bundledGuide());
    symlinkSync(elsewhere, bundledGuide());
    expect(refusal()).toContain(bundledGuide());
  });
});
