// Deterministic real-fs fixtures for the selectable flow catalog (A1 #132, §18.7). A catalog is a directory
// of per-flow-home entries — `<id>/flow.yaml` co-located with `<id>/todo-templates/*.md` (§18.6) — and the
// slice-3 install tests hand one to withBundle('flowCatalog', dir). This builder single-sources what a valid
// entry looks like, and plants the exact anomalies AC4 (a symlinked flow.yaml / todo-templates dir, a
// non-directory catalog member — CWE-59) and AC6 (an unsafe or over-long entry name) provoke.
//
// It writes structural fixtures for the damaged/unsafe destination-plan cases; it is NOT the runnable-flow
// fixture. The AC2/AC3 "resolves as a runnable flow" assertions read the REAL committed bundle
// (example/flows/*), whose steps bind real loops-v2 defs — not synthesised content.
//
// Symlink targets live OUTSIDE the catalog so a leak is a real escape: `outsideDir()` exposes that root for a
// no-leak assertion.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOW_DEF_FILE } from '../../src/main/flow';
import { todoTemplatesDir } from '../../src/main/todoTemplate';

export interface CatalogEntryOptions {
  /** Template refs to co-locate under the entry's todo-templates/ (each becomes a parseable one-todo .md).
   *  Default: a single `ticket-grooming` template. Pass [] for an entry with no templates subdir. */
  templates?: string[];
}

export interface CatalogFixture {
  /** Create an empty catalog root dir (tracked). This is the dir a test passes to withBundle('flowCatalog'). */
  makeCatalogDir(prefix?: string): string;
  /** Write a structurally-valid flow-home entry `<id>/flow.yaml` + `<id>/todo-templates/<ref>.md` under
   *  `catalogDir`. `id` is the entry directory name VERBATIM — pass an unsafe or over-long name to drive the
   *  installer's catalog-id refusal (AC6); the fixture never sanitizes it. Returns the entry dir. */
  addEntry(catalogDir: string, id: string, opts?: CatalogEntryOptions): string;
  /** Replace entry `id`'s flow.yaml with a symlink to out-of-catalog content (CWE-59; AC4). */
  symlinkEntryFlowYaml(catalogDir: string, id: string): void;
  /** Replace entry `id`'s flow.yaml with a DANGLING symlink — its target does not exist, so the entry cannot
   *  be reduced to a real path (`unresolvable`), distinct from an escaping-but-real link (CWE-59/CWE-367). */
  danglingEntryFlowYaml(catalogDir: string, id: string): void;
  /** Replace entry `id`'s todo-templates/ with a symlink to an out-of-catalog dir of .md files (AC4). */
  symlinkEntryTemplatesDir(catalogDir: string, id: string): void;
  /** Plant a catalog-root member that is NOT a directory — a symlink to out-of-catalog content (AC4). */
  symlinkCatalogMember(catalogDir: string, name: string): void;
  /** Plant a catalog-root member that is NOT a directory — a stray regular file (AC4). */
  fileCatalogMember(catalogDir: string, name: string): void;
  /** The out-of-catalog root every planted symlink points into — for a "nothing leaked from here" assertion. */
  outsideDir(): string;
  /** Remove every temp dir this fixture created (catalog roots + the shared outside dir). */
  cleanup(): void;
}

const FLOW_YAML = (id: string): string => `name: ${JSON.stringify(id)}\nsteps:\n  - id: only\n    kind: manual\n`;
const TEMPLATE_MD = (ref: string): string => `# ${ref}\n\n- one seeded todo for ${ref}\n`;

export function createCatalogFixture(): CatalogFixture {
  const tracked: string[] = [];
  let outside: string | null = null;
  let planted = 0;

  const outsideRoot = (): string => {
    if (outside === null) {
      outside = mkdtempSync(join(tmpdir(), 'catalog-outside-'));
      tracked.push(outside);
    }
    return outside;
  };

  // A uniquely-named out-of-catalog file, so repeated plants in one test never collide.
  const outsideFile = (name: string, contents: string): string => {
    const abs = join(outsideRoot(), `${planted++}-${name}`);
    writeFileSync(abs, contents);
    return abs;
  };
  const outsideTemplatesDir = (): string => {
    const abs = join(outsideRoot(), `${planted++}-evil-templates`);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'leak.md'), '# leak\n\n- leaked todo\n');
    return abs;
  };

  return {
    makeCatalogDir(prefix = 'catalog-') {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tracked.push(dir);
      return dir;
    },
    addEntry(catalogDir, id, opts) {
      const entry = join(catalogDir, id);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, FLOW_DEF_FILE), FLOW_YAML(id));
      const refs = opts?.templates ?? ['ticket-grooming'];
      if (refs.length > 0) {
        const templates = todoTemplatesDir(entry);
        mkdirSync(templates, { recursive: true });
        for (const ref of refs) writeFileSync(join(templates, `${ref}.md`), TEMPLATE_MD(ref));
      }
      return entry;
    },
    symlinkEntryFlowYaml(catalogDir, id) {
      const entry = join(catalogDir, id);
      mkdirSync(entry, { recursive: true });
      const flowYaml = join(entry, FLOW_DEF_FILE);
      rmSync(flowYaml, { force: true, recursive: true });
      symlinkSync(outsideFile('evil.yaml', 'name: evil\nsteps: []\n'), flowYaml);
    },
    danglingEntryFlowYaml(catalogDir, id) {
      const entry = join(catalogDir, id);
      mkdirSync(entry, { recursive: true });
      const flowYaml = join(entry, FLOW_DEF_FILE);
      rmSync(flowYaml, { force: true, recursive: true });
      symlinkSync(join(outsideRoot(), `${planted++}-nonexistent-target.yaml`), flowYaml);
    },
    symlinkEntryTemplatesDir(catalogDir, id) {
      const entry = join(catalogDir, id);
      mkdirSync(entry, { recursive: true });
      const templates = todoTemplatesDir(entry);
      rmSync(templates, { force: true, recursive: true });
      symlinkSync(outsideTemplatesDir(), templates);
    },
    symlinkCatalogMember(catalogDir, name) {
      symlinkSync(outsideFile('member', 'out-of-catalog content\n'), join(catalogDir, name));
    },
    fileCatalogMember(catalogDir, name) {
      writeFileSync(join(catalogDir, name), 'a stray non-directory catalog member\n');
    },
    outsideDir() {
      return outsideRoot();
    },
    cleanup() {
      while (tracked.length) rmSync(tracked.pop()!, { recursive: true, force: true });
      outside = null;
    },
  };
}
