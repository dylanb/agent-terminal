import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  applyInstallExamples,
  previewInstallExamples,
  exampleInstallDirs,
  type InstallDestination,
} from '../../src/main/installExamples';
import { isSafePathSegment, MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import { loadTodoTemplateFile, parseTodoTemplate, todoTemplatesDir } from '../../src/main/todoTemplate';
import { flowCatalogDir } from '../../src/main/flow';
import type { InstallDestinationFiles, InstallDestinationId } from '../../src/shared/ipc';
import { createCatalogFixture, type CatalogFixture } from '../helpers/catalogFixture';

// A1 (#132) acceptance: the user-invoked Install-examples action seeds a CATALOG of more than one named
// flow at the location the flow resolver reads (§18.1/§23.4 — <A>/.agent-terminal/flows/), keeping
// feature-dev installable, refusing damaged/unsafe bundle members, and proving each installed entry
// resolves as a runnable flow. Every assertion is on an OBSERVABLE outcome — the grouped install result,
// the files at the reader's read location, the parsed definition + resolvable templates — never on how the
// installer walks a tree. Every fs read is guarded so an absent target fails the ASSERTION, never throws.

const FLOW_CATALOG: InstallDestinationId = 'flowCatalog' as InstallDestinationId;

// The catalog's read location is derived through flowCatalogDir (§18.1) — the writer-target resolver the
// install seeds through and A2 reads back — so this acceptance observation cannot drift from the seeded
// location (CLAUDE.md writer↔reader rule).
const catalogDirFor = (home: string): string => flowCatalogDir(home);
const BUNDLE_FLOWS = path.resolve('example', 'flows');

/** Directory names under `dir`, or [] when `dir` is absent — so "the catalog is empty / missing" fails an
 *  assertion on the returned list rather than throwing ENOENT out of the test. */
const entryDirs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

const filesFor = (groups: InstallDestinationFiles[], id: InstallDestinationId): string[] =>
  groups.find((g) => g.destination === id)?.files ?? [];

/** The bundle's own catalog id set, enumerated (never hard-coded) so the acceptance set tracks the shipped
 *  bundle rather than a frozen literal (§18.1). */
const bundleCatalogIds = (): string[] => entryDirs(BUNDLE_FLOWS);

let home: string;
let configRoot: string;
let dirs: InstallDestination[];
let fx: CatalogFixture;

const seam = (): InstallDestination[] =>
  exampleInstallDirs({ packaged: false, appPath: process.cwd() }, { flowGlobalDir: home, configDir: configRoot, codexHome: path.join(home, '.codex') });
const withBundle = (id: InstallDestinationId, bundleDir: string): InstallDestination[] =>
  dirs.map((d) => (d.id === id ? { ...d, bundleDir } : d));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'flow-catalog-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'flow-catalog-cfg-'));
  dirs = seam();
  fx = createCatalogFixture();
});
afterEach(() => {
  fx.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

describe('AC1 — the install seeds a catalog of >1 named flow at the resolver read location', () => {
  it('exposes a flowCatalog install destination', () => {
    expect(dirs.map((d) => d.id)).toContain(FLOW_CATALOG);
  });

  it('reports a Flow-catalog group and lands >1 enumerable flow at <home>/.agent-terminal/flows/', () => {
    const res = applyInstallExamples(dirs, []);

    const created = filesFor(res.created, FLOW_CATALOG);
    expect(created.length).toBeGreaterThan(0);
    expect(created).toContain(path.join('feature-dev-v3', 'flow.yaml'));

    // The bundle must ship more than one catalog flow, and every one of them must be seeded at the
    // reader's read location — the set is enumerated from the bundle, never hard-coded.
    const bundleIds = bundleCatalogIds();
    expect(bundleIds.length).toBeGreaterThanOrEqual(2);
    const installed = entryDirs(catalogDirFor(home));
    expect(installed).toEqual(bundleIds);
    for (const id of installed) {
      expect(existsSync(path.join(catalogDirFor(home), id, 'flow.yaml'))).toBe(true);
    }
  });
});

describe('AC2 — every installed catalog flow resolves as a runnable flow with its templates', () => {
  it('parses each entry flow.yaml to a named, non-empty definition whose template refs resolve', () => {
    applyInstallExamples(dirs, []);
    const catalog = catalogDirFor(home);
    const installed = entryDirs(catalog);
    expect(installed.length).toBeGreaterThanOrEqual(2);

    let resolvedTemplates = 0;
    for (const id of installed) {
      const entry = path.join(catalog, id);
      const doc = parseYaml(readFileSync(path.join(entry, 'flow.yaml'), 'utf8')) as {
        name?: unknown;
        steps?: Array<{ todo_template?: unknown }>;
      };
      expect(typeof doc.name).toBe('string');
      expect(Array.isArray(doc.steps) && doc.steps.length > 0).toBe(true);

      for (const step of doc.steps ?? []) {
        if (typeof step.todo_template !== 'string') continue;
        const body = loadTodoTemplateFile(todoTemplatesDir(entry), step.todo_template);
        expect(body, `${id} step template ${step.todo_template}`).not.toBeNull();
        expect(parseTodoTemplate(body as string).length).toBeGreaterThan(0);
        resolvedTemplates++;
      }
    }
    expect(resolvedTemplates).toBeGreaterThan(0);
  });
});

describe('AC3 — feature-dev-v3 is the global-fallback flow and a catalog entry; the retired flows ship nowhere', () => {
  it('seeds feature-dev-v3 both as the global-fallback flow and as a named catalog entry', () => {
    applyInstallExamples(dirs, []);

    const fallback = path.join(home, '.agent-terminal', 'flow.yaml');
    expect(existsSync(fallback)).toBe(true);
    if (existsSync(fallback)) expect((parseYaml(readFileSync(fallback, 'utf8')) as { name?: unknown }).name).toBe('feature-dev-v3');

    const featureDev = path.join(catalogDirFor(home), 'feature-dev-v3', 'flow.yaml');
    expect(existsSync(featureDev)).toBe(true);
    if (existsSync(featureDev)) {
      const doc = parseYaml(readFileSync(featureDev, 'utf8')) as { name?: unknown };
      expect(doc.name).toBe('feature-dev-v3');
    }
  });

  it('installs no feature-dev or feature-dev-v2 catalog entry or loop folder', () => {
    applyInstallExamples(dirs, []);
    for (const retired of ['feature-dev', 'feature-dev-v2']) {
      expect(entryDirs(catalogDirFor(home))).not.toContain(retired);
      expect(entryDirs(path.join(configRoot, 'loops-v2'))).not.toContain(retired);
    }
  });
});

describe('AC4 — a damaged catalog bundle member is refused; nothing is written', () => {
  it('refuses a symlinked entry flow.yaml and leaves the catalog untouched (CWE-59)', () => {
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.symlinkEntryFlowYaml(catalog, 'evil');

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('evil');
    expect(res.created).toEqual([]);
    expect(res.overwritten).toEqual([]);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });

  it('refuses the PREVIEW of a damaged catalog bundle, so no consent is computed from it (CWE-59)', () => {
    // The refusal must land while PLANNING, not just at apply: a preview that reads a symlinked bundle and
    // reports a clean, conflict-free catalog drives an apply the user never consented to (§18.1).
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.symlinkEntryFlowYaml(catalog, 'evil');

    const pre = previewInstallExamples(withBundle(FLOW_CATALOG, catalog));

    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.error).toContain('evil');
  });

  it('refuses a symlinked entry todo-templates directory (CWE-59)', () => {
    const catalog = fx.makeCatalogDir();
    fx.symlinkEntryTemplatesDir(catalog, 'feature-dev');

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('feature-dev');
    expect(res.created).toEqual([]);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });

  it('refuses a non-directory catalog member — a safe-named stray file or symlink at the catalog root (CWE-59)', () => {
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    // Both members carry SAFE catalog ids, so the AC6 name gate cannot refuse either — only the
    // catalog-root non-directory check can, which is the CWE-59 read-through this test pins.
    fx.fileCatalogMember(catalog, 'stray');
    fx.symlinkCatalogMember(catalog, 'sneaky');

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/stray|sneaky/);
    expect(res.created).toEqual([]);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });

  it('refuses an existing-but-empty catalog bundle — a mispackaged tree is a named refusal, not a silent install of nothing (§18.1/CWE-754)', () => {
    // The catalog root EXISTS but ships zero flows — a damaged/tampered bundle (the shipped catalog always
    // carries feature-dev + ≥1 more, AC1/AC3). It must be refused with a named error like every other
    // detectable bundle problem, never enumerated as "no files" and reported as a successful install of
    // nothing (§18.1) — the exact silent-partial-install AC4 forbids.
    const catalog = fx.makeCatalogDir();

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/catalog/i);
    expect(res.created).toEqual([]);
    expect(res.overwritten).toEqual([]);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });
});

describe('AC5 — a first install on a machine with no prior config creates the catalog tree from scratch', () => {
  it('creates <home>/.agent-terminal/flows/ and its entries when the app-state root is absent', () => {
    // First-run pin (CLAUDE.md): remove the WHOLE app-state root, not just the catalog parent — a fixture
    // that pre-creates it proves nothing about the fresh machine the feature is for.
    rmSync(path.join(home, '.agent-terminal'), { recursive: true, force: true });

    applyInstallExamples(dirs, []);

    const featureDev = path.join(catalogDirFor(home), 'feature-dev-v3', 'flow.yaml');
    expect(existsSync(featureDev)).toBe(true);
    expect(entryDirs(catalogDirFor(home)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('AC6 — install refuses an entry name the flow resolver would reject; every installed name is safe', () => {
  it('refuses an entry whose name is not a safe catalog id', () => {
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.addEntry(catalog, 'Bad.Name');

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });

  it('refuses an entry whose name exceeds the catalog-id length bound', () => {
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.addEntry(catalog, 'a'.repeat(MAX_CATALOG_ID_LENGTH + 1));

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(false);
    expect(entryDirs(catalogDirFor(home))).toEqual([]);
  });

  it('installs a valid fixture catalog and accepts a name at exactly the length bound', () => {
    const catalog = fx.makeCatalogDir();
    const maxName = 'a'.repeat(MAX_CATALOG_ID_LENGTH);
    fx.addEntry(catalog, 'feature-dev');
    fx.addEntry(catalog, maxName);

    const res = applyInstallExamples(withBundle(FLOW_CATALOG, catalog), []);

    expect(res.ok).toBe(true);
    const installed = entryDirs(catalogDirFor(home));
    expect(installed).toContain('feature-dev');
    expect(installed).toContain(maxName);
  });

  it('accepts every name it actually installs — each is a safe id within the length bound', () => {
    applyInstallExamples(dirs, []);
    const installed = entryDirs(catalogDirFor(home));
    expect(installed.length).toBeGreaterThanOrEqual(2);
    for (const id of installed) {
      expect(isSafePathSegment(id), `installed catalog id ${JSON.stringify(id)}`).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_CATALOG_ID_LENGTH);
    }
  });
});
