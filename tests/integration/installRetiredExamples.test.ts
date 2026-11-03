import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyInstallExamples,
  createInstallExamplesCoordinator,
  exampleInstallDirs,
  previewInstallExamples,
  type InstallDestination,
} from '../../src/main/installExamples';
import { flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { RETIRED_LOOPS } from '../../src/main/retiredExamples';
import { RETIRED_FLOW_IDS } from '../../src/shared/retiredFlows';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir, resolveFeatureDevFlowDir } from '../../src/main/exampleAssets';
import { SESSION_ID, type InstallDestinationId, type RetiredExample } from '../../src/shared/ipc';
import { useBuiltBundle } from '../helpers/builtBundle';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

const builtBundle = useBuiltBundle();

// §18.1 — Install examples offers to remove what the retired feature-dev and feature-dev-v2 flows left
// in an installation: their catalog entries, their loop folders, and the reviewer agents of the loops only they
// shipped. Removal is opt-in, limited to what the preview listed, and never touches anything else.

let home: string;
let configRoot: string;
let codexHome: string;
let dirs: InstallDestination[];

const seam = (): InstallDestination[] =>
  exampleInstallDirs(builtBundle(), { flowGlobalDir: home, configDir: configRoot, codexHome });

function plant(file: string, body = 'old\n'): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

const catalog = (): string => flowCatalogDir(home);
const claudeLoops = (): string => path.join(configRoot, 'loops-v2');
const claudeAgents = (): string => path.join(configRoot, 'agents');
const codexLoops = (): string => path.join(codexHome, 'loops-v2');
const codexAgents = (): string => path.join(codexHome, 'agents');

/** Every remnant an older build left, keyed the way the preview names it. */
function plantRemnants(): RetiredExample[] {
  plant(path.join(catalog(), 'feature-dev', 'flow.yaml'));
  plant(path.join(catalog(), 'feature-dev-v2', 'todo-templates', 'polish.md'));
  plant(path.join(claudeLoops(), 'feature-dev-v2', 'plan-bundle-loop', 'plan-bundle-loop.yaml'));
  plant(path.join(claudeAgents(), 'plan-bundle-loop--review-plan-intent.md'));
  plant(path.join(claudeAgents(), 'plan-polish-loop--review-plan-security.md'));
  plant(path.join(codexLoops(), 'feature-dev-v2', 'red-loop', 'red-loop.yaml'));
  plant(path.join(codexAgents(), 'plan_polish_loop__review_plan_intent.toml'));
  return [
    { destination: 'flowCatalog', rel: 'feature-dev' },
    { destination: 'flowCatalog', rel: 'feature-dev-v2' },
    { destination: 'appLoops', rel: 'feature-dev-v2' },
    { destination: 'agents', rel: 'plan-bundle-loop--review-plan-intent.md' },
    { destination: 'agents', rel: 'plan-polish-loop--review-plan-security.md' },
    { destination: 'codexLoops', rel: 'feature-dev-v2' },
    { destination: 'codexAgents', rel: 'plan_polish_loop__review_plan_intent.toml' },
  ] as RetiredExample[];
}

const remnantPath = (r: RetiredExample): string =>
  path.join(
    ({ flowCatalog: catalog(), appLoops: claudeLoops(), agents: claudeAgents(), codexLoops: codexLoops(), codexAgents: codexAgents() } as Partial<Record<InstallDestinationId, string>>)[r.destination] as string,
    r.rel,
  );

/** What an operator owns beside the remnants, with names chosen to sit right next to them. */
function plantKeepers(): string[] {
  return [
    plant(path.join(catalog(), 'my-flow', 'flow.yaml'), 'mine\n'),
    plant(path.join(catalog(), 'feature-dev-v2-mine', 'flow.yaml'), 'mine\n'),
    plant(path.join(claudeLoops(), 'my-flow', 'green-loop', 'green-loop.yaml'), 'mine\n'),
    plant(path.join(claudeLoops(), 'green-loop', 'green-loop.yaml'), 'mine\n'),
    plant(path.join(claudeAgents(), 'my-agent.md'), 'mine\n'),
    plant(path.join(claudeAgents(), 'plan-bundle-loop--notes.txt'), 'mine\n'),
    plant(path.join(claudeAgents(), 'plan-loop--review-plan-intent.md'), 'mine\n'),
    plant(path.join(claudeAgents(), 'plan-bundle-loop--review-plan-mine.md'), 'mine\n'),
    plant(path.join(codexAgents(), 'mine.toml'), 'mine\n'),
    plant(path.join(codexAgents(), 'plan_polish_loop__review_plan_mine.toml'), 'mine\n'),
    // No build wrote a per-flow folder for v1: #179 renamed it to feature-dev-v2 in the change that added them.
    plant(path.join(claudeLoops(), 'feature-dev', 'green-loop', 'green-loop.yaml'), 'mine\n'),
    plant(path.join(codexLoops(), 'feature-dev', 'green-loop', 'green-loop.yaml'), 'mine\n'),
  ];
}

const byKey = (list: RetiredExample[]): string[] => list.map((r) => `${r.destination}:${r.rel}`).sort();

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'retired-home-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'retired-cfg-'));
  codexHome = path.join(home, '.codex');
  mkdirSync(codexHome);
  dirs = seam();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

describe('the preview lists what the retired flows left behind, and nothing else', () => {
  it('names every catalog entry, loop folder and reviewer agent the retired flows installed', () => {
    const remnants = plantRemnants();
    plantKeepers();

    const preview = previewInstallExamples(dirs);

    expect(preview.ok).toBe(true);
    if (preview.ok) expect(byKey(preview.retired)).toEqual(byKey(remnants));
  });

  it('lists nothing on an installation the retired flows never reached', () => {
    plantKeepers();
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retired).toEqual([]);
  });

  it('lists nothing on a first run, with no config or app-state root at all', () => {
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retired).toEqual([]);
  });

  it('skips the Codex remnants when Codex is not installed', () => {
    plantRemnants();
    rmSync(codexHome, { recursive: true, force: true });
    const preview = previewInstallExamples(dirs);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(byKey(preview.retired).filter((k) => k.startsWith('codex'))).toEqual([]);
  });
});

describe('the install removes the remnants only when asked', () => {
  it('leaves every remnant in place when removal is not chosen', () => {
    const remnants = plantRemnants();
    const res = applyInstallExamples(dirs, [], { removeRetired: false });
    expect(res.ok).toBe(true);
    expect(res.removed).toEqual([]);
    for (const r of remnants) expect(existsSync(remnantPath(r)), `${r.destination}:${r.rel}`).toBe(true);
  });

  it('removes every remnant, whatever its contents, and reports each one', () => {
    const remnants = plantRemnants();
    const res = applyInstallExamples(dirs, [], { removeRetired: true });
    expect(res.ok).toBe(true);
    expect(byKey(res.removed)).toEqual(byKey(remnants));
    for (const r of remnants) expect(existsSync(remnantPath(r)), `${r.destination}:${r.rel}`).toBe(false);
  });

  it('leaves everything the operator owns byte-for-byte unchanged', () => {
    plantRemnants();
    const keepers = plantKeepers();
    applyInstallExamples(dirs, [], { removeRetired: true });
    for (const k of keepers) expect(readFileSync(k, 'utf8'), k).toBe('mine\n');
  });

  it('removes a remnant that is a symbolic link without touching what it points at', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'retired-outside-'));
    try {
      plant(path.join(outside, 'flow.yaml'), 'elsewhere\n');
      mkdirSync(catalog(), { recursive: true });
      symlinkSync(outside, path.join(catalog(), 'feature-dev'));

      const res = applyInstallExamples(dirs, [], { removeRetired: true });

      expect(res.ok).toBe(true);
      expect(byKey(res.removed)).toEqual(['flowCatalog:feature-dev']);
      expect(existsSync(path.join(catalog(), 'feature-dev'))).toBe(false);
      expect(readFileSync(path.join(outside, 'flow.yaml'), 'utf8')).toBe('elsewhere\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes nothing when a write fails part-way through the install', () => {
    const remnants = plantRemnants();
    mkdirSync(path.join(configRoot, 'commands', 'groom-ticket.md'), { recursive: true });
    const res = applyInstallExamples(dirs, [], { removeRetired: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('groom-ticket.md');
    expect(res.created.length).toBeGreaterThan(0);
    expect(res.removed).toEqual([]);
    for (const r of remnants) expect(existsSync(remnantPath(r)), `${r.destination}:${r.rel}`).toBe(true);
  });

  it('removes nothing when the install itself fails', () => {
    const remnants = plantRemnants();
    const broken = dirs.map((d) => (d.id === 'commands' ? { ...d, bundleDir: path.join(home, 'no-such-bundle') } : d));
    const res = applyInstallExamples(broken, [], { removeRetired: true });
    expect(res.ok).toBe(false);
    expect(res.removed).toEqual([]);
    for (const r of remnants) expect(existsSync(remnantPath(r))).toBe(true);
  });
});

describe('a removal that fails part-way', () => {
  it.skipIf(process.getuid?.() === 0)('reports the failure, and reports as removed exactly what is gone', () => {
    plantRemnants();
    const locked = path.join(catalog(), 'feature-dev-v2', 'todo-templates');
    chmodSync(locked, 0o555);
    try {
      const res = applyInstallExamples(dirs, [], { removeRetired: true });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('Could not remove the retired feature-dev-v2');
      expect(byKey(res.removed)).toEqual(['flowCatalog:feature-dev']);
      expect(existsSync(path.join(catalog(), 'feature-dev'))).toBe(false);
      expect(existsSync(path.join(locked, 'polish.md'))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('the preview names a fallback flow that is still a retired one', () => {
  const fallback = (body: string): string => plant(path.join(flowHomeDir(home), FLOW_DEF_FILE), body);
  const shippedFlow = (): string => readFileSync(path.join(resolveFeatureDevFlowDir(builtBundle()), FLOW_DEF_FILE), 'utf8');
  const named = (id: string): string => shippedFlow().replace(/^name: .*$/m, `name: ${id}`);

  it.each(RETIRED_FLOW_IDS)('names %s when the fallback flow.yaml is that flow', (id) => {
    fallback(named(id));
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retiredFallback).toBe(id);
  });

  it.each([
    ['the shipped flow', (): string => shippedFlow()],
    ['garbled YAML', (): string => '{{{'],
    ['a flow with no name', (): string => shippedFlow().replace(/^name: .*$\n/m, '')],
  ])('names nothing for %s', (_name, body) => {
    fallback(body());
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retiredFallback).toBeNull();
  });

  it('names nothing when there is no fallback flow.yaml yet', () => {
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retiredFallback).toBeNull();
  });
});

describe('the coordinator removes only what its preview offered', () => {
  const coordinator = () => createInstallExamplesCoordinator(() => dirs);

  it('removes the previewed remnants when the apply asks for it', () => {
    const remnants = plantRemnants();
    const c = coordinator();
    const preview = c.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    const res = c.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: true });
    expect(res.ok).toBe(true);
    for (const r of remnants) expect(existsSync(remnantPath(r))).toBe(false);
  });

  it('keeps a remnant that appeared after the preview', () => {
    plant(path.join(catalog(), 'feature-dev', 'flow.yaml'));
    const c = coordinator();
    const preview = c.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    const late = plant(path.join(claudeAgents(), 'plan-polish-loop--review-plan-intent.md'));

    const res = c.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: true });

    expect(res.ok).toBe(true);
    expect(byKey(res.removed)).toEqual(['flowCatalog:feature-dev']);
    expect(existsSync(late)).toBe(true);
  });

  it('refuses a removal its preview did not offer, and writes nothing', () => {
    const c = coordinator();
    const preview = c.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.retired).toEqual([]);

    const res = c.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: true });

    expect(res.ok).toBe(false);
    expect(existsSync(path.join(home, '.agent-terminal', 'flow.yaml'))).toBe(false);
  });
});

describe('nothing the bundle still ships is ever offered for removal', () => {

  it('ships no retired flow in the catalog or the loop tree', () => {
    for (const root of [resolveExampleFlowsDir(builtBundle()), resolveExampleLoopsV2Dir(builtBundle())]) {
      for (const id of RETIRED_FLOW_IDS) expect(readdirSync(root), root).not.toContain(id);
    }
  });

  it('ships no retired loop under any flow', () => {
    const loops = resolveExampleLoopsV2Dir(builtBundle());
    for (const flow of readdirSync(loops)) {
      for (const loop of RETIRED_LOOPS) expect(readdirSync(path.join(loops, flow)), flow).not.toContain(loop);
    }
  });

  it('offers nothing for removal right after a fresh install', () => {
    applyInstallExamples(dirs, []);
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retired).toEqual([]);
  });
});
