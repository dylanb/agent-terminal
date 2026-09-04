import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { parseTodoTemplate, isTodoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { FLOW_DEF_FILE } from '../../src/main/flow';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import { createCatalogFixture, type CatalogFixture } from '../helpers/catalogFixture';

// Self-test for the catalog fixture builder (A1 #132 infra). The builder is what the slice-3 catalog-install
// tests (AC4 damaged bundle, AC6 unsafe/over-long entry name) hand to withBundle('flowCatalog', dir); it must
// (1) produce structurally-valid flow-home entries a runnable-flow read path could parse, (2) plant the exact
// anomalies those ACs provoke, (3) write an unsafe/over-long entry name VERBATIM (no sanitizing — the point is
// the installer rejects it), and (4) clean up every temp dir it created. Assertions are on the fixture's
// observable output on disk, never on how it writes it.

let fx: CatalogFixture;
afterEach(() => fx.cleanup());

describe('catalog fixture builder — a structurally-valid catalog of flow-home entries', () => {
  it('creates an empty catalog root under the temp dir', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    expect(existsSync(catalog)).toBe(true);
    expect(catalog.startsWith(tmpdir())).toBe(true);
    expect(readdirSync(catalog)).toEqual([]);
  });

  it('writes a flow-home entry: a real flow.yaml (name + steps) and real co-located .md templates', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    const entry = fx.addEntry(catalog, 'feature-dev', { templates: ['ticket-grooming', 'polish'] });

    expect(entry).toBe(join(catalog, 'feature-dev'));

    // flow.yaml is a real file (not a link) that parses to a definition with a name and at least one step.
    const flowYaml = join(entry, FLOW_DEF_FILE);
    expect(lstatSync(flowYaml).isFile()).toBe(true);
    const def = parseYaml(readFileSync(flowYaml, 'utf8')) as { name?: string; steps?: unknown[] };
    expect(def.name).toBe('feature-dev');
    expect(Array.isArray(def.steps) && def.steps.length > 0).toBe(true);

    // Each requested template is a real .md the picker would list AND the parser yields ≥1 todo from.
    const templates = todoTemplatesDir(entry);
    for (const ref of ['ticket-grooming', 'polish']) {
      const file = join(templates, `${ref}.md`);
      expect(lstatSync(file).isFile()).toBe(true);
      expect(isTodoTemplateFile(`${ref}.md`)).toBe(true);
      expect(parseTodoTemplate(readFileSync(file, 'utf8')).length).toBeGreaterThan(0);
    }
  });

  it('holds more than one enumerable entry so "a catalog of >1 flow" is expressible', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.addEntry(catalog, 'plan-only');
    const entries = readdirSync(catalog, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(entries.map((e) => e.name).sort()).toEqual(['feature-dev', 'plan-only']);
    for (const e of entries) expect(existsSync(join(catalog, e.name, FLOW_DEF_FILE))).toBe(true);
  });

  it('templates: [] yields an entry with a flow.yaml but no todo-templates/ subdir', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    const entry = fx.addEntry(catalog, 'plan-only', { templates: [] });
    expect(existsSync(join(entry, FLOW_DEF_FILE))).toBe(true);
    expect(existsSync(todoTemplatesDir(entry))).toBe(false);
  });

  it('the default (no templates opt) seeds one parseable ticket-grooming.md under todo-templates/', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    const entry = fx.addEntry(catalog, 'feature-dev');
    const file = join(todoTemplatesDir(entry), 'ticket-grooming.md');
    expect(existsSync(file)).toBe(true);
    expect(parseTodoTemplate(readFileSync(file, 'utf8')).length).toBeGreaterThan(0);
  });
});

// Cross-slice coupling: AC4's damaged-member refusal is escape-based (CWE-59/367, §18.7.6 — see
// resolveContained in src/main/todoTemplate.ts). A planted symlink whose target regressed to INSIDE the
// catalog would silently weaken every downstream refusal test, so pin that each resolves under outsideDir().
const expectResolvesOutsideCatalog = (linkPath: string, outsideRoot: string): void => {
  expect(realpathSync(linkPath).startsWith(realpathSync(outsideRoot) + sep)).toBe(true);
};

describe('catalog fixture builder — the damaged-bundle variants (AC4)', () => {
  it("makes an entry's flow.yaml a symlink to out-of-catalog content", () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.symlinkEntryFlowYaml(catalog, 'feature-dev');
    const flowYaml = join(catalog, 'feature-dev', FLOW_DEF_FILE);
    expect(lstatSync(flowYaml).isSymbolicLink()).toBe(true);
    expectResolvesOutsideCatalog(flowYaml, fx.outsideDir());
  });

  it("makes an entry's todo-templates/ a symlink to an out-of-catalog dir", () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.symlinkEntryTemplatesDir(catalog, 'feature-dev');
    const templates = todoTemplatesDir(join(catalog, 'feature-dev'));
    expect(lstatSync(templates).isSymbolicLink()).toBe(true);
    expectResolvesOutsideCatalog(templates, fx.outsideDir());
  });

  it('plants a catalog-root member that is NOT a directory (a symlink, and a stray file)', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    fx.symlinkCatalogMember(catalog, 'linked-entry');
    fx.fileCatalogMember(catalog, 'stray.txt');
    const linked = lstatSync(join(catalog, 'linked-entry'));
    expect(linked.isSymbolicLink()).toBe(true);
    expect(linked.isDirectory()).toBe(false);
    expectResolvesOutsideCatalog(join(catalog, 'linked-entry'), fx.outsideDir());
    const stray = lstatSync(join(catalog, 'stray.txt'));
    expect(stray.isFile()).toBe(true);
    expect(stray.isDirectory()).toBe(false);
  });
});

describe('catalog fixture builder — the unsafe-name variants (AC6)', () => {
  it('writes an unsafe or over-long entry name VERBATIM (never sanitizes the name under test)', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    const overLong = 'a'.repeat(MAX_CATALOG_ID_LENGTH + 1);
    fx.addEntry(catalog, 'Bad.Name');
    fx.addEntry(catalog, overLong);
    const names = readdirSync(catalog);
    expect(names).toContain('Bad.Name'); // the installer, not the fixture, is what must reject it
    expect(names).toContain(overLong);
    expect(existsSync(join(catalog, 'Bad.Name', FLOW_DEF_FILE))).toBe(true);
  });
});

describe('catalog fixture builder — hermetic teardown', () => {
  it('removes every temp dir it created, including the symlink-target (outside) content', () => {
    fx = createCatalogFixture();
    const catalog = fx.makeCatalogDir();
    fx.addEntry(catalog, 'feature-dev');
    fx.symlinkEntryFlowYaml(catalog, 'feature-dev');
    const outside = fx.outsideDir();
    expect(existsSync(catalog)).toBe(true);
    expect(existsSync(outside)).toBe(true);

    fx.cleanup();

    expect(existsSync(catalog)).toBe(false);
    expect(existsSync(outside)).toBe(false);
    fx = createCatalogFixture(); // afterEach cleanup() needs a live fixture; this one tracks nothing
  });
});
