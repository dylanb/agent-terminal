import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, readdirSync, chmodSync, cpSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyInstallExamples,
  createInstallExamplesCoordinator,
  exampleInstallDirs,
  previewInstallExamples,
  type InstallDestination,
} from '../../src/main/installExamples';
import { FLOW_DEF_FILE, flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { RETIRED_LOOPS, removeRetiredEntry } from '../../src/main/retiredExamples';
import { RETIRED_FLOW_IDS } from '../../src/shared/retiredFlows';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir, resolveFeatureDevFlowDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { listLoopFolders } from '../../src/main/loopFolders';
import { SESSION_ID, type InstallDestinationId, type RetiredExample, type RetiredKind } from '../../src/shared/ipc';
import { bundledLoopDir } from '../helpers/bundledLoops';

// §18.1 — Install examples offers to remove what the retired feature-dev and feature-dev-v2 flows left
// in an installation: their catalog entries, their loop folders, and the reviewer agents of the loops only they
// shipped. Removal is opt-in, limited to what the preview listed, and never touches anything else.

let home: string;
let configRoot: string;
let codexHome: string;
let dirs: InstallDestination[];

const seam = (): InstallDestination[] =>
  exampleInstallDirs({ packaged: false, appPath: process.cwd() }, { flowGlobalDir: home, configDir: configRoot, codexHome });

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
    { destination: 'flowCatalog', rel: 'feature-dev', kind: 'retired-flow' },
    { destination: 'flowCatalog', rel: 'feature-dev-v2', kind: 'retired-flow' },
    { destination: 'appLoops', rel: 'feature-dev-v2', kind: 'retired-flow' },
    { destination: 'agents', rel: 'plan-bundle-loop--review-plan-intent.md', kind: 'retired-flow' },
    { destination: 'agents', rel: 'plan-polish-loop--review-plan-security.md', kind: 'retired-flow' },
    { destination: 'codexLoops', rel: 'feature-dev-v2', kind: 'retired-flow' },
    { destination: 'codexAgents', rel: 'plan_polish_loop__review_plan_intent.toml', kind: 'retired-flow' },
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
const byKind = (list: RetiredExample[]): string[] => list.map((r) => `${r.kind}:${r.destination}:${r.rel}`).sort();

const OLD_FLOW = 'simple-dev-v1';
const MOVED: readonly string[] = [
  'simple-plan-approve-loop-v1',
  'simple-dev-loop-v1',
  'simple-integration-slice-loop-v1',
  'simple-impl-approve-loop-v1',
  'simple-finalize-loop-v1',
];
const STAYED = 'simple-plan-loop-v1';

/** A copy of each bundled loop in `flowDir`, the way an older build installed it under its flow's folder. */
function plantOldCopies(flowDir: string, loops: readonly string[] = MOVED): void {
  for (const loop of loops) cpSync(bundledLoopDir(loop), path.join(flowDir, loop), { recursive: true });
}

const oldCopyOffers = (destination: InstallDestinationId): RetiredExample[] =>
  MOVED.map((loop) => ({ destination, rel: path.join(OLD_FLOW, loop), kind: 'moved-loop' }) as RetiredExample);

const movedLoopOffers = (list: RetiredExample[]): RetiredExample[] => list.filter((r) => r.kind === 'moved-loop');

function filesOf(dir: string): Record<string, string> {
  const rels = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((rel) => statSync(path.join(dir, rel)).isFile());
  return Object.fromEntries(rels.sort().map((rel) => [rel, readFileSync(path.join(dir, rel), 'base64')]));
}

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
    if (preview.ok) expect(byKind(preview.retired)).toEqual(byKind(remnants));
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

    expect(applyInstallExamples(dirs, []).ok).toBe(true);

    for (const loop of MOVED) expect(existsSync(path.join(claudeLoops(), loop, `${loop}.yaml`)), loop).toBe(true);
    const after = previewInstallExamples(dirs);
    expect(after.ok).toBe(true);
    if (after.ok) expect(movedLoopOffers(after.retired)).toEqual([]);
  });

  it('skips the Codex remnants when Codex is not installed', () => {
    plantRemnants();
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
    rmSync(codexHome, { recursive: true, force: true });
    const preview = previewInstallExamples(dirs);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(byKey(preview.retired).filter((k) => k.startsWith('codex'))).toEqual([]);
    expect(byKind(movedLoopOffers(preview.retired))).toEqual(byKind(oldCopyOffers('appLoops')));
  });
});

describe('old copies of the loops simple-dev-v1 now shares', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'retired-repo-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const recipeOf = (loop: string): string => {
    const resolved = resolveLoopDefV2(loop, {
      tiers: { operator: claudeLoops(), appBundled: path.join(home, 'no-bundle'), retired: null },
      repoDir: repo,
      flow: OLD_FLOW,
    });
    if (!resolved.ok) throw new Error(`${loop}: ${resolved.reason}`);
    return resolved.def.work.recipe;
  };
  const realClaudeLoops = (): string => path.join(realpathSync(configRoot), 'loops-v2');

  it('offers each old copy of a moved loop, for Claude Code and Codex', () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
    plantOldCopies(path.join(codexLoops(), OLD_FLOW));

    const preview = previewInstallExamples(dirs);

    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(byKind(movedLoopOffers(preview.retired))).toEqual(byKind([...oldCopyOffers('appLoops'), ...oldCopyOffers('codexLoops')]));
    }
  });

  it("never offers the flow's own loop that did not move", () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW), [...MOVED, STAYED]);
    plantOldCopies(path.join(codexLoops(), OLD_FLOW), [...MOVED, STAYED]);

    const preview = previewInstallExamples(dirs);

    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.retired.filter((r) => r.rel.includes(STAYED))).toEqual([]);
  });

  it('removes the old copies when asked, and the flow then uses the shared copy', () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW), [...MOVED, STAYED]);

    const res = applyInstallExamples(dirs, [], { removeRetired: true });

    expect(res.ok).toBe(true);
    for (const loop of MOVED) expect(existsSync(path.join(claudeLoops(), OLD_FLOW, loop)), loop).toBe(false);
    expect(existsSync(path.join(claudeLoops(), OLD_FLOW, STAYED))).toBe(true);
    for (const loop of MOVED) expect(recipeOf(loop).startsWith(path.join(realClaudeLoops(), loop) + path.sep), loop).toBe(true);
  });

  it('keeps the old copies when removal is not chosen', () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));

    const res = applyInstallExamples(dirs, [], { removeRetired: false });

    expect(res.ok).toBe(true);
    for (const loop of MOVED) {
      expect(existsSync(path.join(claudeLoops(), OLD_FLOW, loop)), loop).toBe(true);
      expect(recipeOf(loop).startsWith(path.join(realClaudeLoops(), OLD_FLOW, loop) + path.sep), loop).toBe(true);
    }
  });

  it('offers nothing under a linked flow folder and leaves its target alone', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'retired-linked-flow-'));
    const nothingPerFlow = mkdtempSync(path.join(tmpdir(), 'retired-bundle-'));
    try {
      plantOldCopies(outside);
      plant(path.join(nothingPerFlow, 'shared-loop', 'shared-loop.yaml'), 'name: shared-loop\n');
      mkdirSync(claudeLoops(), { recursive: true });
      symlinkSync(outside, path.join(claudeLoops(), OLD_FLOW));
      const linked = dirs.map((d) => (d.id === 'appLoops' ? { ...d, bundleDir: nothingPerFlow } : d));
      const before = filesOf(outside);

      const preview = previewInstallExamples(linked);
      const res = applyInstallExamples(linked, [], { removeRetired: true });

      expect(preview.ok).toBe(true);
      if (preview.ok) expect(movedLoopOffers(preview.retired)).toEqual([]);
      expect(res.ok).toBe(true);
      expect(Object.keys(before).length).toBeGreaterThan(0);
      expect(filesOf(outside)).toEqual(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(nothingPerFlow, { recursive: true, force: true });
    }
  });

  it('refuses the install when the flow folder is linked outside, with the real bundle, and leaves the link target alone', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'retired-linked-flow-'));
    try {
      plantOldCopies(outside, [...MOVED, STAYED]);
      mkdirSync(claudeLoops(), { recursive: true });
      symlinkSync(outside, path.join(claudeLoops(), OLD_FLOW));
      const before = filesOf(outside);

      const preview = previewInstallExamples(dirs);
      const res = applyInstallExamples(dirs, [], { removeRetired: true });

      expect(preview.ok).toBe(false);
      if (!preview.ok) {
        expect(preview.error).toMatch(/symbolic link/);
        expect(preview.error).toContain(OLD_FLOW);
      }
      expect(res.ok).toBe(false);
      expect(Object.keys(before).length).toBeGreaterThan(0);
      expect(filesOf(outside)).toEqual(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never offers or removes a moved loop the bundle ships in the flow folder again', () => {
    const bundle = mkdtempSync(path.join(tmpdir(), 'retired-reshipped-'));
    try {
      const [reshipped, ...stillMoved] = MOVED;
      if (reshipped === undefined) throw new Error('no moved loop');
      cpSync(resolveExampleLoopsV2Dir({ packaged: false, appPath: process.cwd() }), bundle, { recursive: true });
      cpSync(bundledLoopDir(reshipped), path.join(bundle, OLD_FLOW, reshipped), { recursive: true });
      const withReshipped = dirs.map((d) => (d.id === 'appLoops' ? { ...d, bundleDir: bundle } : d));
      plantOldCopies(path.join(claudeLoops(), OLD_FLOW));

      const preview = previewInstallExamples(withReshipped);
      const res = applyInstallExamples(withReshipped, [], { removeRetired: true });

      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(byKind(movedLoopOffers(preview.retired).filter((r) => r.destination === 'appLoops'))).toEqual(
          byKind(stillMoved.map((loop) => ({ destination: 'appLoops', rel: path.join(OLD_FLOW, loop), kind: 'moved-loop' }) as RetiredExample)),
        );
      }
      expect(res.ok).toBe(true);
      expect(existsSync(path.join(claudeLoops(), OLD_FLOW, reshipped, `${reshipped}.yaml`))).toBe(true);
      for (const loop of stillMoved) expect(existsSync(path.join(claudeLoops(), OLD_FLOW, loop)), loop).toBe(false);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('a removal re-checks the flow folder at the moment of the delete', () => {
  it('refuses a moved-loop entry whose flow folder became a link after the preview, and leaves the target alone', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'retired-swapped-flow-'));
    try {
      plantOldCopies(outside);
      mkdirSync(claudeLoops(), { recursive: true });
      symlinkSync(outside, path.join(claudeLoops(), OLD_FLOW));
      const before = filesOf(outside);
      const rel = path.join(OLD_FLOW, MOVED[0]);

      expect(() => removeRetiredEntry(claudeLoops(), rel, 'moved-loop')).toThrow(/no longer a real folder/);

      expect(filesOf(outside)).toEqual(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes a moved-loop entry under a real flow folder', () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
    const rel = path.join(OLD_FLOW, MOVED[0]);

    removeRetiredEntry(claudeLoops(), rel, 'moved-loop');

    expect(existsSync(path.join(claudeLoops(), rel))).toBe(false);
    expect(existsSync(path.join(claudeLoops(), OLD_FLOW, MOVED[1]))).toBe(true);
  });

  it('removes a single retired-flow entry that is a link, without touching its target', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'retired-link-entry-'));
    try {
      plant(path.join(outside, 'flow.yaml'), 'elsewhere\n');
      mkdirSync(claudeLoops(), { recursive: true });
      symlinkSync(outside, path.join(claudeLoops(), 'feature-dev-v2'));

      removeRetiredEntry(claudeLoops(), 'feature-dev-v2', 'retired-flow');

      expect(existsSync(path.join(claudeLoops(), 'feature-dev-v2'))).toBe(false);
      expect(readFileSync(path.join(outside, 'flow.yaml'), 'utf8')).toBe('elsewhere\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('the install re-checks a flow folder swapped for a link around its removal', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(path.join(tmpdir(), 'retired-swapped-flow-'));
    plantOldCopies(outside, [...MOVED, STAYED]);
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  const linkFlowFolderOutside = (): void => {
    rmSync(path.join(claudeLoops(), OLD_FLOW), { recursive: true, force: true });
    symlinkSync(outside, path.join(claudeLoops(), OLD_FLOW));
  };

  it('fails naming the old copy when the folder becomes a link just before it is removed, and leaves the link target alone', () => {
    const before = filesOf(outside);
    let linked = false;
    const linkThenRemove = (jail: string, rel: string, kind: RetiredKind): void => {
      if (!linked) {
        linked = true;
        linkFlowFolderOutside();
      }
      removeRetiredEntry(jail, rel, kind);
    };

    const preview = previewInstallExamples(dirs);
    const res = applyInstallExamples(dirs, [], { removeRetired: true, removeLeftover: linkThenRemove });

    expect(filesOf(outside)).toEqual(before);
    expect(preview.ok && byKind(movedLoopOffers(preview.retired))).toEqual(byKind(oldCopyOffers('appLoops')));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(new RegExp(`Could not remove the old ${OLD_FLOW}/(${MOVED.join('|')}) .*no longer a real folder`));
    expect(movedLoopOffers(res.removed)).toEqual([]);
  });

  it('refuses the whole install with the real bundle when the folder became a link after the preview', () => {
    const before = filesOf(outside);
    const c = createInstallExamplesCoordinator(() => dirs);
    const preview = c.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    linkFlowFolderOutside();

    const res = c.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: true });

    expect(filesOf(outside)).toEqual(before);
    expect(byKind(movedLoopOffers(preview.retired))).toEqual(byKind(oldCopyOffers('appLoops')));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(OLD_FLOW);
    expect(res.removed).toEqual([]);
  });

  it('removes no old copy when the bundle ships nothing in the flow folder and the folder became a link after the preview', () => {
    const nothingPerFlow = mkdtempSync(path.join(tmpdir(), 'retired-bundle-'));
    try {
      plant(path.join(nothingPerFlow, 'shared-loop', 'shared-loop.yaml'), 'name: shared-loop\n');
      const linked = dirs.map((d) => (d.id === 'appLoops' ? { ...d, bundleDir: nothingPerFlow } : d));
      const before = filesOf(outside);
      const c = createInstallExamplesCoordinator(() => linked);
      const preview = c.preview({ sessionId: SESSION_ID });
      if (!preview.ok) throw new Error(preview.error);
      linkFlowFolderOutside();

      const res = c.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: true });

      expect(filesOf(outside)).toEqual(before);
      expect(byKind(movedLoopOffers(preview.retired))).toEqual(byKind(oldCopyOffers('appLoops')));
      expect(res.ok).toBe(true);
      expect(movedLoopOffers(res.removed)).toEqual([]);
    } finally {
      rmSync(nothingPerFlow, { recursive: true, force: true });
    }
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
    expect(byKind(res.removed)).toEqual(byKind(remnants));
    for (const r of remnants) expect(existsSync(remnantPath(r)), `${r.destination}:${r.rel}`).toBe(false);
  });

  it('removes retired-flow remnants and old moved-loop copies together, and reports each as its own kind', () => {
    const remnants = plantRemnants();
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
    plantOldCopies(path.join(codexLoops(), OLD_FLOW));
    const moved = [...oldCopyOffers('appLoops'), ...oldCopyOffers('codexLoops')];

    const res = applyInstallExamples(dirs, [], { removeRetired: true });

    expect(res.ok).toBe(true);
    expect(byKind(res.removed)).toEqual(byKind([...remnants, ...moved]));
    for (const r of [...remnants, ...moved]) expect(existsSync(remnantPath(r)), `${r.destination}:${r.rel}`).toBe(false);
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
      expect(byKind(res.removed)).toEqual(['retired-flow:flowCatalog:feature-dev']);
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
  it.skipIf(process.getuid?.() === 0)('words a failed removal of an old shared-loop copy as old', () => {
    plantOldCopies(path.join(claudeLoops(), OLD_FLOW));
    const locked = path.join(claudeLoops(), OLD_FLOW, MOVED[0]);
    chmodSync(locked, 0o555);
    try {
      const res = applyInstallExamples(dirs, [], { removeRetired: true });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(`Could not remove the old ${path.join(OLD_FLOW, MOVED[0])}`);
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports the failure, and reports as removed exactly what is gone', () => {
    plantRemnants();
    const locked = path.join(catalog(), 'feature-dev-v2', 'todo-templates');
    chmodSync(locked, 0o555);
    try {
      const res = applyInstallExamples(dirs, [], { removeRetired: true });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('Could not remove the retired feature-dev-v2');
      expect(byKind(res.removed)).toEqual(['retired-flow:flowCatalog:feature-dev']);
      expect(existsSync(path.join(catalog(), 'feature-dev'))).toBe(false);
      expect(existsSync(path.join(locked, 'polish.md'))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('the preview names a fallback flow that is still a retired one', () => {
  const fallback = (body: string): string => plant(path.join(flowHomeDir(home), FLOW_DEF_FILE), body);
  const shippedFlow = (): string => readFileSync(path.join(resolveFeatureDevFlowDir({ packaged: false, appPath: process.cwd() }), FLOW_DEF_FILE), 'utf8');
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
    expect(byKind(res.removed)).toEqual(['retired-flow:flowCatalog:feature-dev']);
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
  const loc = { packaged: false as const, appPath: process.cwd() };

  it('ships no retired flow in the catalog or the loop tree', () => {
    for (const root of [resolveExampleFlowsDir(loc), resolveExampleLoopsV2Dir(loc)]) {
      for (const id of RETIRED_FLOW_IDS) expect(readdirSync(root), root).not.toContain(id);
    }
  });

  it('ships no retired loop, under a flow or in the shared folder', () => {
    const folders = listLoopFolders(resolveExampleLoopsV2Dir(loc));
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) expect(RETIRED_LOOPS, folder.dir).not.toContain(folder.name);
  });

  it('offers nothing for removal right after a fresh install', () => {
    applyInstallExamples(dirs, []);
    const preview = previewInstallExamples(dirs);
    expect(preview.ok && preview.retired).toEqual([]);
  });
});
