import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  previewInstallExamples,
  applyInstallExamples,
  destRelative,
  exampleInstallDirs,
  createInstallExamplesCoordinator,
  type InstallDestination,
  type InstallExamplesInspection,
} from '../../src/main/installExamples';
import { load as parseYaml } from 'js-yaml';
import { flowCatalogDir, loadFlowDefinitionLocalFirst } from '../../src/main/flow';
import {
  isTodoTemplateFile,
  listTodoTemplates,
  loadTodoTemplateFile,
  parseTodoTemplate,
  todoTemplatesDir,
} from '../../src/main/todoTemplate';
import {
  SESSION_ID,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../../src/shared/ipc';

// Drive the real installer with real fs against the ACTUAL bundled example trees (§18.1).
// Assertions are on the observable outcomes the ACs name — per-destination created/overwritten/skipped
// sets, byte-for-byte preservation on decline, all-or-nothing on an unwritable container — never on how
// the installer walks a tree. Every expected file set is enumerated FROM THE BUNDLE, never hard-coded:
// a hard-coded list silently under-installs the next bundle refresh.

const BUNDLE_FLOW = path.resolve('example', 'flows', 'feature-dev-v2');
const BUNDLE_APP_LOOPS = path.resolve('example', 'loops-v2');
const BUNDLE_COMMANDS = path.resolve('example', 'commands');

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function walk(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))],
  );
}

// The flow install set is flow.yaml + the .md todo templates (§18.6) — NOT a bare recursive walk.
const FLOW_SET = [
  'flow.yaml',
  ...readdirSync(path.join(BUNDLE_FLOW, 'todo-templates'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('todo-templates', f)),
];
const APP_LOOPS_SET = walk(BUNDLE_APP_LOOPS);
const COMMANDS_SET = walk(BUNDLE_COMMANDS);
const APP_LOOP_NAMES = readdirSync(BUNDLE_APP_LOOPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

let home: string;
let configRoot: string;
let dirs: InstallDestination[];

const flowRel = 'flow.yaml';
const templateRel = path.join('todo-templates', 'ticket-grooming.md');
const planDefRel = path.join('plan-loop', 'plan-loop.yaml');
const commandRel = 'groom-ticket.md';

// The real bundle resolves from cwd (path.resolve('example', …)), so appPath: process.cwd() yields the
// actual bundled trees; home/configRoot give the temp install targets. Tests that need a broken bundle
// swap one destination's bundleDir with withBundle — the opaque plan strategy travels untouched.
const seam = (): InstallDestination[] => exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, configRoot);
const destOf = (id: InstallDestinationId): InstallDestination => dirs.find((d) => d.id === id) as InstallDestination;
/** The destination's target. `targetDir` is nullable because a relative CLAUDE_CONFIG_DIR is refused; these
 *  fixtures always supply an absolute one, so a null here is a broken fixture, not a case under test. */
const targetDirOf = (id: InstallDestinationId): string => {
  const t = destOf(id).targetDir;
  if (t === null) throw new Error(`fixture supplied no target for ${id}`);
  return t;
};
const withBundle = (id: InstallDestinationId, bundleDir: string): InstallDestination[] =>
  dirs.map((d) => (d.id === id ? { ...d, bundleDir } : d));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'install-examples-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'install-examples-cfg-'));
  dirs = seam();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

const ALL: InstallDestinationId[] = ['flow', 'appLoops', 'commands'];
const targetOf = (id: InstallDestinationId, rel: string): string => path.join(targetDirOf(id), rel);
const filesFor = (
  groups: { destination: InstallDestinationId; files: string[] }[],
  id: InstallDestinationId,
): string[] => groups.find((g) => g.destination === id)?.files ?? [];
const okOf = (res: InstallExamplesResult): Extract<InstallExamplesResult, { ok: true }> => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`);
  return res;
};
const previewOk = (
  res: InstallExamplesInspection,
): InstallDestinationPreview[] => {
  if (!res.ok) throw new Error(`expected a preview, got error: ${res.error}`);
  return res.destinations;
};
const conflictsFor = (
  res: InstallExamplesInspection,
  id: InstallDestinationId,
): string[] => {
  const d = previewOk(res).find((x) => x.destination === id);
  return d && d.conflict ? [...d.files] : [];
};

// A relative CLAUDE_CONFIG_DIR names no single directory — Claude Code resolves it against ITS cwd, not
// ours — so the install refuses rather than anchoring it at this process's cwd, which under `electron-vite
// dev` is the repo root: the app loop definitions and the commands would land in the user's working tree,
// reporting success, and be discovered from there on a later run (CWE-829).
describe('a relative user-config root is refused, not anchored at the process cwd', () => {
  const relativeDirs = (): InstallDestination[] =>
    exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, '~/.claude');

  it('refuses the apply, names CLAUDE_CONFIG_DIR, and writes nothing anywhere', () => {
    const before = walk(home);
    const res = applyInstallExamples(relativeDirs(), []);

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('CLAUDE_CONFIG_DIR');
    // A config destination's root comes from CLAUDE_CONFIG_DIR alone; $HOME has no bearing on it, and a
    // refusal that names it sends the user to change a variable that is not the cause.
    expect(res.ok ? '' : res.error).not.toContain('$HOME');
    expect(walk(home)).toEqual(before);
    expect(existsSync(path.join(process.cwd(), '~'))).toBe(false);
  });

  it('refuses the preview too, so no consent step is ever computed from a guessed path', () => {
    const res = previewInstallExamples(relativeDirs());
    expect(res.ok).toBe(false);
  });

  // The FLOW destination's root is the launch home (§23.4), NOT the config dir — so an absolute
  // CLAUDE_CONFIG_DIR does not save it. A defined-but-empty $HOME makes that root relative
  // (`.agent-terminal`), which would seed flow.yaml + templates into the launch cwd (the repo under dev).
  // The gate is at the RESOLVER: a relative flow home yields a null targetDir. Asserting that FIRST means a
  // regression fails here — before any write — so the probe can never pollute the repo the bug targets.
  it('refuses the flow destination when its home root is relative (empty $HOME)', () => {
    const relFlowDirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, '', configRoot);
    const flow = relFlowDirs.find((d) => d.id === 'flow');
    expect(flow?.targetDir).toBeNull(); // the gate — a removed gate fails here, no filesystem touched

    const res = applyInstallExamples(relFlowDirs, []); // null target → refuse, nothing written
    expect(res.ok).toBe(false);
    expect(existsSync(path.join(process.cwd(), '.agent-terminal', 'flow.yaml'))).toBe(false);

    // The refusal must name the variable that ACTUALLY governs this destination. CLAUDE_CONFIG_DIR is
    // absolute and blameless here — telling the user to set or unset it sends them to change a variable
    // with no bearing on the flow home, while the empty $HOME that caused it goes unmentioned.
    expect(res.ok ? '' : res.error).toContain('$HOME');
    expect(res.ok ? '' : res.error).not.toContain('CLAUDE_CONFIG_DIR');
  });
});

describe('applyInstallExamples — a clean run seeds every destination and reports each file under it', () => {
  it('reports every bundled file created under the destination it was written to', () => {
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(filesFor(res.created, 'appLoops').sort()).toEqual([...APP_LOOPS_SET].sort());
    expect(filesFor(res.created, 'commands').sort()).toEqual([...COMMANDS_SET].sort());
    expect(res.overwritten).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it('writes bytes identical to the bundle at every destination', () => {
    applyInstallExamples(dirs, []);
    expect(readFileSync(targetOf('flow', flowRel))).toEqual(readFileSync(path.join(BUNDLE_FLOW, flowRel)));
    expect(readFileSync(targetOf('appLoops', planDefRel))).toEqual(readFileSync(path.join(BUNDLE_APP_LOOPS, planDefRel)));
    expect(readFileSync(targetOf('commands', commandRel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, commandRel)));
  });

  it('gives an app loop directory a file at every relative path its bundled directory has (§27.15)', () => {
    applyInstallExamples(dirs, []);
    for (const loop of APP_LOOP_NAMES) {
      for (const rel of walk(path.join(BUNDLE_APP_LOOPS, loop))) {
        const installed = path.join(targetDirOf('appLoops'), loop, rel);
        expect(existsSync(installed)).toBe(true);
        expect(readFileSync(installed)).toEqual(readFileSync(path.join(BUNDLE_APP_LOOPS, loop, rel)));
      }
    }
  });

  it('seeds every bundled command, misses none, and holds exactly one file per command name', () => {
    applyInstallExamples(dirs, []);
    expect(COMMANDS_SET.length).toBeGreaterThan(0);
    for (const rel of COMMANDS_SET) {
      expect(readFileSync(path.join(targetDirOf('commands'), rel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, rel)));
    }
    expect(walk(targetDirOf('commands')).sort()).toEqual([...COMMANDS_SET].sort());
  });

  it('seeds no command into the flow home', () => {
    applyInstallExamples(dirs, []);
    for (const rel of COMMANDS_SET) expect(existsSync(path.join(targetDirOf('flow'), rel))).toBe(false);
    expect(existsSync(path.join(targetDirOf('flow'), 'commands'))).toBe(false);
  });

  it('installs the flow destination as flow.yaml + .md templates only — never a bare recursive walk', () => {
    applyInstallExamples(dirs, []);
    // The flow home also holds the selectable catalog (a sibling destination nested under it, §18.7.1);
    // exclude that subtree so this still pins that the FLOW destination itself seeds only flow.yaml + templates.
    const catalogRel = path.relative(targetDirOf('flow'), flowCatalogDir(home));
    const flowOnly = walk(targetDirOf('flow')).filter((r) => r !== catalogRel && !r.startsWith(catalogRel + path.sep));
    expect(flowOnly.sort()).toEqual([...FLOW_SET].sort());
  });

  // The writer↔reader pin: the installer must seed the templates where the READER looks for them, so both
  // sides derive the location and the extension from `todoTemplate`'s own resolver. Asserting through
  // `listTodoTemplates` is what makes it able to fail — a literal that drifts on either side lands the
  // files somewhere the picker does not read, and the picker then comes back empty.
  it('seeds the templates where the todo-template reader looks for them', () => {
    applyInstallExamples(dirs, []);
    const flowDir = targetDirOf('flow');

    const seeded = listTodoTemplates(todoTemplatesDir(flowDir)).map((t) => t.ref).sort();
    const bundled = readdirSync(todoTemplatesDir(BUNDLE_FLOW))
      .filter(isTodoTemplateFile)
      .map((f) => f.replace(/\.md$/, ''))
      .sort();

    expect(bundled.length).toBeGreaterThan(0);
    expect(seeded).toEqual(bundled);
  });

  it('reports a file name occurring in two loop definitions as two distinct entries', () => {
    const shared = APP_LOOPS_SET.filter((r) => r.startsWith(`${APP_LOOP_NAMES[0]}${path.sep}`))
      .map((r) => path.relative(APP_LOOP_NAMES[0], r))
      .filter((r) => APP_LOOPS_SET.includes(path.join(APP_LOOP_NAMES[1], r)));
    expect(shared.length).toBeGreaterThan(0); // the bundle really does share names across definitions

    const created = filesFor(okOf(applyInstallExamples(dirs, [])).created, 'appLoops');
    for (const rel of shared) {
      expect(created).toContain(path.join(APP_LOOP_NAMES[0], rel));
      expect(created).toContain(path.join(APP_LOOP_NAMES[1], rel));
    }
  });
});

describe('a bundle member that cannot be READ is a refusal, never an install of less (absent ≠ unreadable)', () => {
  // CLAUDE.md's enumeration rule: absent yields nothing, unreadable THROWS — conflating them "reports a
  // successful install of nothing". The flow plan asks whether the bundle's todo-templates/ is a real
  // directory, and a lstat that fails for ANY reason other than absence is not an answer to that question:
  // an optional subtree that is not there is a legitimate empty, an unreadable one is a broken build.
  // The refusal must land while PLANNING — preview included, since a preview that cannot read the bundle
  // and reports "nothing conflicts" drives an apply the user never consented to (§18.1).
  it.skipIf(asRoot)('refuses the preview rather than reporting a clean, conflict-free bundle it cannot read', () => {
    const bundle = mkdtempSync(path.join(tmpdir(), 'flow-bundle-'));
    try {
      writeFileSync(path.join(bundle, 'flow.yaml'), 'steps: []\n');
      mkdirSync(path.join(bundle, 'todo-templates'));
      chmodSync(bundle, 0o600); // readable, NOT traversable — its members cannot be lstat'd

      const pre = previewInstallExamples(withBundle('flow', bundle));

      expect(pre.ok).toBe(false);
      if (pre.ok) return;
      // Names a bundle member it could not read. WHICH one is walk order, not contract — every member of an
      // untraversable bundle is unreadable, so the refusal names the first one reached.
      expect(pre.error).toMatch(/flow\.yaml|todo-templates/);
    } finally {
      chmodSync(bundle, 0o700);
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)('refuses the apply before the first write, seeding no destination', () => {
    const bundle = mkdtempSync(path.join(tmpdir(), 'flow-bundle-'));
    try {
      writeFileSync(path.join(bundle, 'flow.yaml'), 'steps: []\n');
      mkdirSync(path.join(bundle, 'todo-templates'));
      chmodSync(bundle, 0o600);

      const res = applyInstallExamples(withBundle('flow', bundle), ALL);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      for (const id of ALL) expect(walk(targetOf(id, '.'))).toEqual([]);
    } finally {
      chmodSync(bundle, 0o700);
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  // The absent case must stay a legitimate empty: a loop that ships no todo-templates/ is not a broken build.
  it('still installs a flow bundle that simply has no todo-templates directory', () => {
    const bundle = mkdtempSync(path.join(tmpdir(), 'flow-bundle-'));
    try {
      writeFileSync(path.join(bundle, 'flow.yaml'), 'steps: []\n');

      const res = applyInstallExamples(withBundle('flow', bundle), ALL);

      expect(res.ok).toBe(true);
      expect(filesFor(res.created, 'flow')).toEqual(['flow.yaml']);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('previewInstallExamples — per-destination conflicts, and nothing is ever written', () => {
  it('reports no conflict in any destination when everything is clean', () => {
    const preview = previewOk(previewInstallExamples(dirs));
    for (const id of ALL) expect(preview.find((d) => d.destination === id)?.conflict).toBe(false);
  });

  it('creates no file and no directory in any destination', () => {
    previewInstallExamples(dirs);
    for (const id of ALL) expect(existsSync(targetOf(id, '.'))).toBe(false);
  });

  it('reports no conflict when every present target is byte-identical (never prompted twice)', () => {
    applyInstallExamples(dirs, []);
    const preview = previewOk(previewInstallExamples(dirs));
    for (const id of ALL) expect(preview.find((d) => d.destination === id)?.conflict).toBe(false);
  });

  it('reports exactly the differing targets, grouped under their own destination', () => {
    mkdirSync(path.dirname(targetOf('appLoops', planDefRel)), { recursive: true });
    writeFileSync(targetOf('appLoops', planDefRel), 'name: my-own-def\n');
    mkdirSync(targetDirOf('commands'), { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'my own command\n');

    const preview = previewInstallExamples(dirs);
    expect(conflictsFor(preview, 'appLoops')).toEqual([planDefRel]);
    expect(conflictsFor(preview, 'commands')).toEqual([commandRel]);
    expect(conflictsFor(preview, 'flow')).toEqual([]);
  });
});

describe('applyInstallExamples — one replace decision per destination, never one covering two', () => {
  function seedConflicts(): { defBody: string; commandBody: string; flowBody: string } {
    const defBody = 'name: my-own-def\n';
    const commandBody = 'my own command\n';
    const flowBody = 'name: my-custom-flow\nsteps: []\n';
    mkdirSync(path.dirname(targetOf('appLoops', planDefRel)), { recursive: true });
    writeFileSync(targetOf('appLoops', planDefRel), defBody);
    mkdirSync(targetDirOf('commands'), { recursive: true });
    writeFileSync(targetOf('commands', commandRel), commandBody);
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), flowBody);
    return { defBody, commandBody, flowBody };
  }

  it('replaces in the consented destination and leaves the declined one byte-for-byte unchanged', () => {
    const { defBody, commandBody } = seedConflicts();
    const res = okOf(applyInstallExamples(dirs, ['commands']));

    expect(filesFor(res.overwritten, 'commands')).toContain(commandRel);
    expect(filesFor(res.skipped, 'appLoops')).toContain(planDefRel);
    expect(readFileSync(targetOf('commands', commandRel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, commandRel)));
    expect(readFileSync(targetOf('appLoops', planDefRel), 'utf8')).toBe(defBody);
    expect(commandBody).not.toBe(readFileSync(targetOf('commands', commandRel), 'utf8'));
  });

  it('replaces in the appLoops destination while declining commands — the mirror decision', () => {
    const { defBody, commandBody } = seedConflicts();
    const res = okOf(applyInstallExamples(dirs, ['appLoops']));

    expect(filesFor(res.overwritten, 'appLoops')).toContain(planDefRel);
    expect(filesFor(res.skipped, 'commands')).toContain(commandRel);
    expect(readFileSync(targetOf('commands', commandRel), 'utf8')).toBe(commandBody);
    expect(readFileSync(targetOf('appLoops', planDefRel), 'utf8')).not.toBe(defBody);
  });

  it('leaves a pre-existing app-loop definition untouched on decline, whatever produced it', () => {
    const { defBody } = seedConflicts();
    okOf(applyInstallExamples(dirs, []));
    expect(readFileSync(targetOf('appLoops', planDefRel), 'utf8')).toBe(defBody);
  });

  it('leaves a pre-existing command file untouched on decline, whatever produced it', () => {
    const { commandBody } = seedConflicts();
    okOf(applyInstallExamples(dirs, []));
    expect(readFileSync(targetOf('commands', commandRel), 'utf8')).toBe(commandBody);
  });

  it('still seeds the flow home when the user declines every other destination', () => {
    const { flowBody } = seedConflicts();
    const res = okOf(applyInstallExamples(dirs, ['flow']));
    expect(filesFor(res.overwritten, 'flow')).toContain(flowRel);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).not.toBe(flowBody);
    expect(existsSync(targetOf('flow', templateRel))).toBe(true);
  });

  it('seeds the flow home even while a conflict in another destination is declined', () => {
    seedConflicts();
    rmSync(targetOf('flow', flowRel)); // flow home is clean; appLoops + commands still conflict
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(existsSync(targetOf('flow', flowRel))).toBe(true);
  });

  it('creates absent files in a declined destination — a decline withholds no creation', () => {
    mkdirSync(targetDirOf('commands'), { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'mine\n');
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.skipped, 'commands')).toEqual([commandRel]);
    expect(filesFor(res.created, 'appLoops').sort()).toEqual([...APP_LOOPS_SET].sort());
  });

  it('reports every file skipped and surfaces no conflict on a second identical run', () => {
    applyInstallExamples(dirs, []);
    const res = okOf(applyInstallExamples(dirs, []));
    expect(res.created).toEqual([]);
    expect(res.overwritten).toEqual([]);
    expect(filesFor(res.skipped, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(filesFor(res.skipped, 'appLoops').sort()).toEqual([...APP_LOOPS_SET].sort());
    expect(filesFor(res.skipped, 'commands').sort()).toEqual([...COMMANDS_SET].sort());
    for (const d of previewOk(previewInstallExamples(dirs))) expect(d.conflict).toBe(false);
  });
});

describe('the shipped-flow overwrite policy is checked before consent or write (ST3 AC10)', () => {
  function forbiddenFlowDestination(): InstallDestination {
    return {
      ...destOf('flow'),
      overwrite: { mode: 'forbid-overwrite' },
    };
  }

  function seedExistingFlow(): string {
    const body = 'name: keep-me\nsteps:\n  - id: mine\n    kind: manual\n';
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), body);
    return body;
  }

  it('hard-fails detection instead of offering an overwrite when authorization is absent', () => {
    const original = seedExistingFlow();

    const preview = previewInstallExamples([forbiddenFlowDestination()]);

    expect(preview).toEqual({
      ok: false,
      error: expect.stringMatching(/overwrite policy|not authorized/i),
    });
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).toBe(original);
  });

  it('re-checks authorization at the write even if a caller submits confirmation directly', () => {
    const original = seedExistingFlow();

    const result = applyInstallExamples(
      [forbiddenFlowDestination()],
      ['flow'],
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(
      /overwrite policy|not authorized/i,
    );
    expect(result.created).toEqual([]);
    expect(result.overwritten).toEqual([]);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).toBe(original);
  });
});

describe('applyInstallExamples — all-or-nothing across destinations when unwritability is detectable', () => {
  it.skipIf(asRoot).each(ALL)(
    'writes nothing anywhere when the %s container resolves somewhere unwritable',
    (id) => {
      // The destination roots are app-derived, so a link the user placed at one is followed to its real
      // location (see the dotfiles describe below). What must still refuse UP FRONT is a root that cannot
      // be written — including one reached through the user's own link (CWE-829).
      const target = targetOf(id, '.');
      const real = mkdtempSync(path.join(tmpdir(), 'link-target-'));
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(real, target);
        chmodSync(real, 0o500); // traversable, not writable

        const res = applyInstallExamples(dirs, ALL);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error).toMatch(/cannot be written/);
        expect(res.created).toEqual([]);
        expect(res.overwritten).toEqual([]);
        expect(walk(real)).toEqual([]);
        for (const other of ALL.filter((o) => o !== id)) expect(walk(targetOf(other, '.'))).toEqual([]);
      } finally {
        chmodSync(real, 0o700);
        rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(asRoot)('writes nothing anywhere when a destination container is not writable', () => {
    mkdirSync(targetDirOf('appLoops'), { recursive: true });
    chmodSync(targetDirOf('appLoops'), 0o500); // readable + traversable, not writable
    try {
      const res = applyInstallExamples(dirs, []);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      expect(existsSync(targetOf('flow', flowRel))).toBe(false);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
    } finally {
      chmodSync(targetDirOf('appLoops'), 0o700);
    }
  });

  // POSIX needs SEARCH (`x`), not just `w`, to create a file in a directory — so `w`-without-`x` is the
  // case where a writability probe that asks only for W_OK would pass a container the write then fails on,
  // mid-install, after earlier destinations had already landed. §18.1's all-or-nothing is what forbids that,
  // and it is the OUTCOME pinned here, not the probe: no destination may be seeded when any container is
  // unusable, however the refusal is arrived at.
  it.skipIf(asRoot)('writes nothing anywhere when a destination container is writable but not traversable', () => {
    mkdirSync(targetDirOf('appLoops'), { recursive: true });
    chmodSync(targetDirOf('appLoops'), 0o600); // readable + writable, NOT traversable
    try {
      const res = applyInstallExamples(dirs, []);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      expect(existsSync(targetOf('flow', flowRel))).toBe(false);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
      // The container IS readable here — only search permission is missing — so a refusal that told the
      // user to check readability would send them to inspect a bit that is already set.
      expect(res.error).toMatch(/traversable/);
    } finally {
      chmodSync(targetDirOf('appLoops'), 0o700);
    }
  });
});

describe('applyInstallExamples — a symlink nested inside a destination is refused BEFORE the first write (CWE-59)', () => {
  // §18.1 puts the link-following refusal in the pre-write check: "if any check fails, nothing is written
  // anywhere". Confining only as each file is reached would satisfy the refusal but not the guarantee —
  // the destinations planned ahead of the offending one would already be on disk.
  it.each([
    ["the file's own container", path.join('plan-loop', 'charter')],
    ['an intermediate ancestor', 'plan-loop'],
    ['an ancestor two levels below the destination', path.join('plan-loop', 'prompts')],
  ])('refuses when %s under the appLoops destination is a symlink, and writes nothing anywhere', (_label, rel) => {
    const real = mkdtempSync(path.join(tmpdir(), 'link-target-'));
    try {
      const link = path.join(targetDirOf('appLoops'), rel);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(real, link);

      const res = applyInstallExamples(dirs, ALL);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('a symbolic link stands on the path to it');
      expect(res.error).toContain('plan-loop');
      expect(walk(real)).toEqual([]); // nothing written through the link

      // Nothing landed anywhere: the refusal precedes the first write, so no destination is half-seeded.
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      expect(existsSync(targetDirOf('flow'))).toBe(false);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('applyInstallExamples — a container that is not a directory is never reported as a symbolic link', () => {
  // The write's own container guard refuses ANY non-directory (atomicFile.isRealContainer), but the message
  // it is reported under names a symbolic link. That message is only honest because every OTHER kind of
  // non-directory container is intercepted before the write, by a path that names its own cause. That
  // interception is an ordering invariant of applyInstallExamples, not a property of the guard — so it is
  // pinned here rather than asserted in a comment: a reorder that let a plain file reach the write guard
  // would send the user to replace a symbolic link that is not there.
  it('names the unresolvable path, not a link, when a plain file already occupies a container', () => {
    const appLoopsTarget = targetDirOf('appLoops');
    mkdirSync(appLoopsTarget, { recursive: true });
    writeFileSync(path.join(appLoopsTarget, 'plan-loop'), 'not a directory');

    const res = applyInstallExamples(dirs, ALL);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/symbolic link/i);
    expect(res.error).toMatch(/could not be resolved/);
    expect(res.created).toEqual([]); // refused in the pre-write pass — nothing landed anywhere
  });

  it('names the failed write, not a link, when a container becomes a plain file after the pre-write pass', () => {
    // The pre-write pass gates every container, so the only way one is a non-directory AT THE WRITE is that
    // the tree changed underneath the check (CWE-367). Reproduced deterministically by a plan whose own
    // earlier file lands on the container of a later one — no race, real fs.
    const bundle = mkdtempSync(path.join(tmpdir(), 'install-bundle-'));
    try {
      writeFileSync(path.join(bundle, 'one'), 'first');
      writeFileSync(path.join(bundle, 'two'), 'second');
      const dest: InstallDestination = {
        ...destOf('appLoops'),
        bundleDir: bundle,
        plan: (b) => [
          { rel: destRelative('occupier'), src: path.join(b, 'one') },
          { rel: destRelative(path.join('occupier', 'blocked')), src: path.join(b, 'two') },
        ],
      };

      const res = applyInstallExamples([dest], ALL);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).not.toMatch(/symbolic link/i);
      expect(res.error).toMatch(/not a directory/i);
      expect(res.error).toContain('occupier');
      // The write that DID land is still reported: the action does not roll back (§18.1).
      expect(filesFor(res.created, 'appLoops')).toEqual(['occupier']);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('applyInstallExamples — a container symlink that stays inside the destination is followed, not refused (CWE-59 confinement)', () => {
  // The write path routes through the shared confinement primitive (confinedPath.ts): a container
  // symlink is refused ONLY when it escapes the destination (the tests above), and one that resolves to
  // a real location INSIDE the destination is followed to that symlink-free location (CWE-367) — the same
  // policy every other confined path in the app applies, rather than a blanket refusal of any symlink.
  it('writes a loop whose directory links to a real sibling inside the destination, at the resolved location', () => {
    const appLoopsTarget = targetDirOf('appLoops');
    mkdirSync(appLoopsTarget, { recursive: true });
    const realDir = path.join(appLoopsTarget, 'real-plan');
    mkdirSync(realDir);
    symlinkSync(realDir, path.join(appLoopsTarget, 'plan-loop'));

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // plan-loop/plan-loop.yaml resolves through the in-jail link to real-plan/plan-loop.yaml.
    expect(existsSync(path.join(realDir, 'plan-loop.yaml'))).toBe(true);
    expect(readFileSync(path.join(realDir, 'plan-loop.yaml'))).toEqual(readFileSync(path.join(BUNDLE_APP_LOOPS, planDefRel)));
  });
});

describe('applyInstallExamples — first run seeds a config root that does not exist yet', () => {
  it('creates the whole tree when the user-config root is absent (a fresh machine)', () => {
    rmSync(configRoot, { recursive: true, force: true }); // ~/.claude has never been created
    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(targetOf('appLoops', planDefRel))).toBe(true);
    expect(existsSync(targetOf('commands', commandRel))).toBe(true);
  });
});

describe('applyInstallExamples — a failure once writing has begun names everything already written', () => {
  it('reports every created/overwritten file, and no file outside that list differs from its pre-action bytes', () => {
    // A directory standing where a command file must be written: the pre-flight (a container check)
    // cannot see it, so the failure lands mid-write, after flow/appLoops are on disk.
    mkdirSync(path.join(targetDirOf('commands'), commandRel), { recursive: true });
    // A pre-action file the run will skip (declined), so `no file outside that list` has a real member
    // whose bytes can be compared rather than a vacuously empty set.
    const preserved = targetOf('appLoops', planDefRel);
    const preservedBytes = 'name: my-own-def\n';
    mkdirSync(path.dirname(preserved), { recursive: true });
    writeFileSync(preserved, preservedBytes);

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
    // The failure arm still names what it left alone: the declined definition was correctly skipped, and a
    // caller reconciling the outcome must be able to see that, not infer it from silence.
    expect(filesFor(res.skipped, 'appLoops')).toContain(planDefRel);

    // The catalog (§18.7.1) is nested under the flow home, so the walk of the 'flow' root below sees its
    // files too; they were written by this install, so they belong in the named set exactly as the three
    // ALL destinations' files do — reported under their own group, not ALL's.
    const written: InstallDestinationId[] = [...ALL, 'flowCatalog'];
    const named = new Set(
      written.flatMap((id) => [...filesFor(res.created, id), ...filesFor(res.overwritten, id)].map((r) => targetOf(id, r))),
    );
    expect(named.size).toBeGreaterThan(0); // writing really had begun
    expect(named.has(preserved)).toBe(false);

    let unnamed = 0;
    for (const id of ALL) {
      for (const rel of walk(targetOf(id, '.'))) {
        const abs = targetOf(id, rel);
        if (named.has(abs)) continue;
        unnamed++;
        expect(abs).toBe(preserved);
        expect(readFileSync(abs, 'utf8')).toBe(preservedBytes);
      }
    }
    expect(unnamed).toBe(1);
  });
});

describe('applyInstallExamples — never writes a .gitignore', () => {
  it('creates none anywhere it wrote', () => {
    applyInstallExamples(dirs, ALL);
    for (const dir of [home, configRoot, targetDirOf('flow'), targetDirOf('appLoops'), targetDirOf('commands')]) {
      expect(existsSync(path.join(dir, '.gitignore'))).toBe(false);
    }
  });

  it('leaves a pre-existing one byte-for-byte unchanged', () => {
    const gi = path.join(configRoot, '.gitignore');
    const before = 'node_modules\n.env\n';
    writeFileSync(gi, before);
    applyInstallExamples(dirs, ALL);
    expect(readFileSync(gi, 'utf8')).toBe(before);
  });
});

describe('applyInstallExamples — an existing-but-unreadable target is not mistaken for absent', () => {
  // A traverse/read-permission failure cannot be provoked as root (it bypasses the mode bits), so gate
  // rather than widen a seam into classify (CLAUDE.md it.skipIf guidance).
  it.skipIf(asRoot)('does not silently overwrite a present target it cannot read (EACCES is not absence)', () => {
    mkdirSync(targetDirOf('flow'), { recursive: true });
    const tf = targetOf('flow', flowRel);
    const custom = 'name: my-custom-flow\nsteps: []\n';
    writeFileSync(tf, custom);
    chmodSync(tf, 0o000); // present but unreadable → readFileSync throws EACCES, not ENOENT
    let res: InstallExamplesResult | undefined;
    try {
      res = applyInstallExamples(dirs, []);
    } finally {
      chmodSync(tf, 0o600);
    }
    expect(res?.ok).toBe(false);
    expect(readFileSync(tf, 'utf8')).toBe(custom);
  });
});

describe('applyInstallExamples — a mispackaged bundle is a reported error, not a thrown reject', () => {
  it('returns { ok:false, error } instead of throwing when a bundled file cannot be read', () => {
    const bundleEmpty = mkdtempSync(path.join(tmpdir(), 'bundle-empty-'));
    try {
      mkdirSync(targetDirOf('flow'), { recursive: true });
      writeFileSync(targetOf('flow', flowRel), 'name: my-custom-flow\nsteps: []\n'); // present → bundle read reached
      let res: InstallExamplesResult | undefined;
      expect(() => {
        res = applyInstallExamples(withBundle('flow', bundleEmpty), ['flow']);
      }).not.toThrow();
      expect(res?.ok).toBe(false);
      if (!res || res.ok) return;
      expect(res.error).toBeTruthy();
    } finally {
      rmSync(bundleEmpty, { recursive: true, force: true });
    }
  });

  // A symlink in the bundle is never read through (CWE-59) — but it is REFUSED, not skipped. Skipping it
  // seeds a destination with less than the bundle shipped and reports SUCCESS, which is the "successful
  // install of nothing" §18.1 exists to forbid; for a required member (flow.yaml) it means the destination
  // plans zero files, is dropped from the apply entirely, and the user is told the install worked. The
  // build-time guard (exampleAssetsBuild) keeps a link out of the tree in the first place; this is the
  // second line, for a bundle that is an installed artifact this build did not necessarily write.
  it('refuses a symlink planted in the bundle rather than reading through it OR quietly installing less (CWE-59)', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-link-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-bundle-'));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'not part of the bundle\n');
      mkdirSync(path.join(outside, 'secret-dir'), { recursive: true });
      writeFileSync(path.join(outside, 'secret-dir', 'nested.md'), 'nor is this\n');
      writeFileSync(path.join(bundleX, commandRel), 'a real bundled command\n');
      symlinkSync(path.join(outside, 'secret.md'), path.join(bundleX, 'linked.md'));
      symlinkSync(path.join(outside, 'secret-dir'), path.join(bundleX, 'linked-dir'));

      const res = applyInstallExamples(withBundle('commands', bundleX), []);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('linked'); // names the member it will not read
      expect(res.created).toEqual([]);
      // Not read through, and not partially installed either — not even the one legitimate command.
      expect(walk(targetDirOf('commands'))).toEqual([]);
      expect(existsSync(path.join(targetDirOf('commands'), 'linked.md'))).toBe(false);
      expect(existsSync(path.join(targetDirOf('commands'), 'linked-dir'))).toBe(false);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlink in the FLOW bundle — flow.yaml or a linked todo-templates dir (CWE-59)', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-flow-link-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-flow-'));
    try {
      // flow.yaml is a symlink to outside content; and todo-templates is a symlink to an outside dir of .md
      writeFileSync(path.join(outside, 'evil.yaml'), 'name: evil\nsteps: []\n');
      symlinkSync(path.join(outside, 'evil.yaml'), path.join(bundleX, 'flow.yaml'));
      mkdirSync(path.join(outside, 'evil-templates'), { recursive: true });
      writeFileSync(path.join(outside, 'evil-templates', 'leak.md'), '# leak\n- [ ] x\n');
      symlinkSync(path.join(outside, 'evil-templates'), path.join(bundleX, 'todo-templates'));

      const res = applyInstallExamples(withBundle('flow', bundleX), []);

      // A skip here would drop the whole flow destination (zero planned files) and report ok — an install
      // the user is told succeeded, that never seeded the flow home at all.
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/flow\.yaml|todo-templates/);
      expect(res.created).toEqual([]);
      // Nothing from behind either link is installed.
      expect(existsSync(path.join(targetDirOf('flow'), 'flow.yaml'))).toBe(false);
      expect(existsSync(path.join(targetDirOf('flow'), 'todo-templates', 'leak.md'))).toBe(false);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses the PREVIEW too, so no consent step is computed from a bundle it will not read', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-preview-link-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-preview-'));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'not part of the bundle\n');
      writeFileSync(path.join(bundleX, commandRel), 'a real bundled command\n');
      symlinkSync(path.join(outside, 'secret.md'), path.join(bundleX, 'linked.md'));

      const res = previewInstallExamples(withBundle('commands', bundleX));

      expect(res.ok).toBe(false);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('installs only .md todo templates, never a non-.md flow bundle asset (§18.6)', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-nonmd-'));
    try {
      writeFileSync(path.join(bundleX, flowRel), readFileSync(path.join(BUNDLE_FLOW, flowRel)));
      mkdirSync(path.join(bundleX, 'todo-templates'), { recursive: true });
      writeFileSync(path.join(bundleX, 'todo-templates', 'ticket-grooming.md'), '# t\n- [ ] x\n');
      writeFileSync(path.join(bundleX, 'todo-templates', 'asset.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x90]));

      const res = okOf(applyInstallExamples(withBundle('flow', bundleX), []));
      const binRel = path.join('todo-templates', 'asset.bin');
      expect(filesFor(res.created, 'flow')).not.toContain(binRel);
      expect(existsSync(targetOf('flow', binRel))).toBe(false);
      expect(existsSync(targetOf('flow', path.join('todo-templates', 'ticket-grooming.md')))).toBe(true);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
    }
  });
});

describe('installed bytes are renderable by the runtime read path (§18.1/§18.6)', () => {
  it('loads through loadFlowDefinitionLocalFirst and yields every bundled step id', () => {
    applyInstallExamples(dirs, []);
    const localWithoutFlow = mkdtempSync(path.join(tmpdir(), 'no-local-flow-'));
    try {
      const load = loadFlowDefinitionLocalFirst(localWithoutFlow, home);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      expect(load.definition.name).toBe('feature-dev-v2');
      const bundled = parseYaml(readFileSync(path.join(BUNDLE_FLOW, flowRel), 'utf8')) as { steps: { id: string }[] };
      expect(load.definition.steps.map((s) => s.id)).toEqual(bundled.steps.map((s) => s.id));
    } finally {
      rmSync(localWithoutFlow, { recursive: true, force: true });
    }
  });

  it('resolves every referenced todo_template in the installed todo-templates/ (§18.6)', () => {
    applyInstallExamples(dirs, []);
    const load = loadFlowDefinitionLocalFirst(mkdtempSync(path.join(tmpdir(), 'nl-')), home);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const templatesDir = path.join(load.flowDir, 'todo-templates');
    const listed = listTodoTemplates(templatesDir).map((t) => t.ref);
    for (const step of load.definition.steps) {
      if (!step.todoTemplate) continue;
      expect(listed).toContain(step.todoTemplate);
      const md = loadTodoTemplateFile(templatesDir, step.todoTemplate);
      expect(md).not.toBeNull();
      expect(parseTodoTemplate(md as string).length).toBeGreaterThan(0);
    }
  });
});

describe('an absent bundle source is a refusal, never a silent success (§18.1)', () => {
  // Enumeration is tree-driven, so a mispackaged build (a tree missing from extraResources) yields an
  // EMPTY plan — indistinguishable, to a planner that swallows ENOENT, from a bundle that legitimately
  // carries no files. Reported as ok, the user is told the examples were installed and nothing was.
  const absent = path.join(tmpdir(), 'install-examples-no-such-bundle');

  it.each(['appLoops', 'commands', 'flow', 'flowCatalog'] as const)(
    'reports a failure when the %s bundle tree is missing from the build',
    (id) => {
      const res = applyInstallExamples(withBundle(id, absent), []);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('bundle');
    },
  );

  it('refuses before writing anything, so a mispackaged build seeds no destination at all', () => {
    expect(applyInstallExamples(withBundle('appLoops', absent), []).ok).toBe(false);
    for (const id of ALL) expect(existsSync(targetDirOf(id))).toBe(false);
  });

  it('distinguishes an absent tree from an empty one: an empty bundle installs nothing and says so', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'bundle-empty-tree-'));
    try {
      const res = applyInstallExamples(withBundle('commands', empty), []);
      expect(res.ok).toBe(true);
      expect(filesFor(okOf(res).created, 'commands')).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)('reports a failure when a bundle tree exists but cannot be read (EACCES is not empty)', () => {
    // An unreadable bundle enumerates to nothing exactly as an absent one does. Swallowed, it installs
    // no files and tells the user it succeeded.
    const locked = mkdtempSync(path.join(tmpdir(), 'bundle-locked-'));
    try {
      writeFileSync(path.join(locked, commandRel), 'a real bundled command\n');
      chmodSync(locked, 0o000);
      const res = applyInstallExamples(withBundle('commands', locked), []);
      expect(res.ok).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});

describe('the pre-write writability gate covers the containers the write actually touches', () => {
  it.skipIf(asRoot)('refuses before writing anything when a NESTED container is unwritable', () => {
    // Ticket #41's safety AC is all-or-nothing whenever unwritability is detectable before the first
    // write. Probing only each destination's ROOT detects it only for the root: an unwritable
    // subdirectory the write must enter is found mid-write, after other destinations have landed.
    const appLoops = targetDirOf('appLoops');
    const nested = path.join(appLoops, 'plan-loop');
    mkdirSync(nested, { recursive: true });
    chmodSync(nested, 0o555); // traversable, not writable
    let res: InstallExamplesResult | undefined;
    try {
      res = applyInstallExamples(dirs, []);
    } finally {
      chmodSync(nested, 0o700);
    }
    expect(res?.ok).toBe(false);
    if (!res || res.ok) return;
    expect(res.error).toMatch(/cannot be written/);
    expect(res.created).toEqual([]);
    expect(res.overwritten).toEqual([]);
    expect(existsSync(targetDirOf('flow'))).toBe(false);
    expect(existsSync(targetDirOf('commands'))).toBe(false);
  });
});

describe('a destination root the USER symlinked is followed, not refused — it is their config, not a planted link', () => {
  let dotfiles: string;
  beforeEach(() => {
    dotfiles = mkdtempSync(path.join(tmpdir(), 'install-dotfiles-'));
  });
  afterEach(() => {
    rmSync(dotfiles, { recursive: true, force: true });
  });

  const linkDest = (id: InstallDestinationId, real: string): void => {
    mkdirSync(real, { recursive: true });
    mkdirSync(path.dirname(targetDirOf(id)), { recursive: true });
    symlinkSync(real, targetDirOf(id));
  };

  it('installs through the symlink, landing the files at the resolved location', () => {
    const real = path.join(dotfiles, 'app-loops');
    linkDest('appLoops', real);
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'appLoops').sort()).toEqual([...APP_LOOPS_SET].sort());
    expect(readFileSync(path.join(real, planDefRel))).toEqual(
      readFileSync(path.join(BUNDLE_APP_LOOPS, planDefRel)),
    );
  });

  it('still refuses a symlink INSIDE the resolved root that escapes it (CWE-59)', () => {
    const real = path.join(dotfiles, 'app-loops');
    const outside = path.join(dotfiles, 'outside');
    linkDest('appLoops', real);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(real, 'plan-loop')); // escapes the RESOLVED root

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/symbolic link/);
    expect(walk(outside)).toEqual([]);
  });
});

describe('a refusal names the cause the user has to act on', () => {
  it.skipIf(asRoot)('does not blame a symlink for an unreadable directory on the path', () => {
    // confinedRealPath returns null for MORE than an escaping symlink: an unreadable (EACCES) or
    // non-directory segment cannot be reduced to a real path either. Reporting all of them as "a symbolic
    // link stands on the path" sends the user hunting for a link that does not exist.
    const locked = path.join(targetDirOf('appLoops'), path.dirname(planDefRel));
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    let res: InstallExamplesResult | undefined;
    try {
      res = applyInstallExamples(dirs, []);
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(res?.ok).toBe(false);
    if (!res || res.ok) return;
    expect(res.error).not.toMatch(/symbolic link/);
    expect(res.error).toMatch(/could not be resolved|cannot be read|unreadable/i);
  });

});

describe('installed bytes are the bundle bytes — a non-UTF-8 asset survives the copy', () => {
  // The bundle is a tree the build ships, not a text corpus: a command may legitimately carry a
  // binary asset. Decoding it as UTF-8 on the way out replaces every invalid byte with U+FFFD, so the
  // install corrupts the file AND never converges — the byte-compare that classifies it sees a permanent
  // `differ` and re-writes the same corruption on every run.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x90]);

  it('writes a bundled binary asset byte-for-byte', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-bin-'));
    try {
      writeFileSync(path.join(bundleX, 'logo.png'), bytes);
      const res = okOf(applyInstallExamples(withBundle('commands', bundleX), []));
      expect(filesFor(res.created, 'commands')).toEqual(['logo.png']);
      expect(readFileSync(targetOf('commands', 'logo.png')).equals(bytes)).toBe(true);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
    }
  });

  it('converges: once installed, the binary asset no longer reads as a conflict', () => {
    // The convergence claim, not the reporting one: a corrupted write classifies as `differ` forever, so
    // the user is asked to consent to replacing a file they never changed on every subsequent run.
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-bin2-'));
    try {
      writeFileSync(path.join(bundleX, 'logo.png'), bytes);
      const seamX = withBundle('commands', bundleX);
      applyInstallExamples(seamX, []);
      expect(conflictsFor(previewInstallExamples(seamX), 'commands')).toEqual([]);
    } finally {
      rmSync(bundleX, { recursive: true, force: true });
    }
  });
});

describe('previewInstallExamples — the read path is confined exactly as the write path is (CWE-22/59)', () => {
  // Preview opens every target file to classify it. Unconfined, a symlink standing inside a destination
  // is READ THROUGH: the classification reports on a file outside the destination, so the consent step
  // the user is shown is computed from bytes the installer would never have written.
  it('refuses a destination whose target file is a symlink escaping it, rather than classifying through it', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-preview-'));
    try {
      const secret = path.join(outside, 'secret.md');
      writeFileSync(secret, 'a file outside every destination\n');
      mkdirSync(targetDirOf('commands'), { recursive: true });
      symlinkSync(secret, targetOf('commands', commandRel));

      const res = createInstallExamplesCoordinator(() => dirs).preview({
        sessionId: SESSION_ID,
      });
      expect(res.ok).toBe(false);
      expect(readFileSync(secret, 'utf8')).toBe('a file outside every destination\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)('reports an unreadable target as a refusal instead of throwing out of the handler', () => {
    mkdirSync(targetDirOf('flow'), { recursive: true });
    const tf = targetOf('flow', flowRel);
    writeFileSync(tf, 'name: my-custom-flow\nsteps: []\n');
    chmodSync(tf, 0o000); // present but unreadable → classify's read throws EACCES, not ENOENT
    let res: InstallExamplesInspection | undefined;
    try {
      expect(() => {
        res = createInstallExamplesCoordinator(() => dirs).preview({
          sessionId: SESSION_ID,
        });
      }).not.toThrow();
    } finally {
      chmodSync(tf, 0o600);
    }
    expect(res?.ok).toBe(false);
  });
});

describe('applyInstallExamples — an unresolvable destination jail is a refusal, not a mid-write throw', () => {
  it('refuses when the config root itself is a dangling symlink', () => {
    // A dangling link cannot be reduced to a real location at all, so the jail is unresolvable — which is
    // NOT the same refusal as a link that escapes, and must not be reported as one.
    const cfgLink = path.join(configRoot, 'dangling');
    symlinkSync(path.join(configRoot, 'no-such-target'), cfgLink);
    const linked = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, cfgLink);
    const res = applyInstallExamples(linked, []);
    expect(res.ok).toBe(false);
    // A DANGLING link is unresolvable, not an escape: nothing is being redirected out of the jail, the
    // path simply has no real location. The message says what to check rather than naming a culprit.
    if (!res.ok) expect(res.error).toMatch(/could not be resolved/);
  });
});

describe('install examples coordinator — contract guards (§6)', () => {
  const thunk = (): InstallDestination[] => dirs;

  it('applies for a valid live-session request', () => {
    const coordinator = createInstallExamplesCoordinator(thunk);
    const preview = coordinator.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    const res = coordinator.apply({
      sessionId: SESSION_ID,
      previewId: preview.previewId,
      replace: [],
    });
    expect(res.ok).toBe(true);
    expect(existsSync(targetOf('flow', flowRel))).toBe(true);
    expect(existsSync(targetOf('appLoops', planDefRel))).toBe(true);
  });

  it('rejects a wrong-session apply with an error and performs no filesystem work', () => {
    let consulted = 0;
    const coordinator = createInstallExamplesCoordinator(() => {
      consulted++;
      return dirs;
    });
    const res = coordinator.apply({
      sessionId: 'nope',
      replace: ['flow'],
    });
    expect(res.ok).toBe(false);
    expect(consulted).toBe(0);
    expect(existsSync(targetDirOf('flow'))).toBe(false);
  });

  it('rejects an apply whose replace list is missing or holds an unknown destination', () => {
    const coordinator = createInstallExamplesCoordinator(thunk);
    expect(coordinator.apply({ sessionId: SESSION_ID }).ok).toBe(false);
    const preview = coordinator.preview({ sessionId: SESSION_ID });
    if (!preview.ok) throw new Error(preview.error);
    expect(
      coordinator.apply({
        sessionId: SESSION_ID,
        previewId: preview.previewId,
        replace: ['everything'],
      }).ok,
    ).toBe(false);
    expect(existsSync(targetDirOf('flow'))).toBe(false);
  });

  it('previews conflicts for a live session and refuses a wrong session with an error, not an empty list', () => {
    mkdirSync(targetDirOf('commands'), { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'mine\n');
    const coordinator = createInstallExamplesCoordinator(thunk);
    const live = coordinator.preview({ sessionId: SESSION_ID });
    expect(live.ok).toBe(true);
    expect(conflictsFor(live, 'commands')).toEqual([commandRel]);
    // A refused request is distinguishable from a clean preview: it carries an error, not { destinations: [] }.
    expect(
      coordinator.preview({ sessionId: 'nope' }).ok,
    ).toBe(false);
  });
});

describe('createInstallExamplesCoordinator — preview-bound, one-time authorization', () => {
  const request = (
    previewId: string,
    replace: InstallDestinationId[] = [],
  ) => ({
    sessionId: SESSION_ID,
    previewId,
    replace,
  });

  function preview(
    coordinator: ReturnType<typeof createInstallExamplesCoordinator>,
  ): Extract<InstallExamplesPreview, { ok: true }> {
    const result = coordinator.preview({ sessionId: SESSION_ID });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  it('refuses apply without a main-owned preview authorization', () => {
    const coordinator = createInstallExamplesCoordinator(() => dirs);

    const result = coordinator.apply(request('missing'));

    expect(result.ok).toBe(false);
    expect(existsSync(targetOf('flow', flowRel))).toBe(false);
  });

  it('consumes the preview authorization once and rejects replay', () => {
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    const prepared = preview(coordinator);

    expect(coordinator.apply(request(prepared.previewId)).ok).toBe(true);
    expect(coordinator.apply(request(prepared.previewId)).ok).toBe(false);
  });

  it('a second preview replaces the pending authorization with a fresh snapshot', () => {
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), 'first\n');
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    preview(coordinator);
    writeFileSync(targetOf('flow', flowRel), 'second\n');
    const prepared = preview(coordinator);

    const result = coordinator.apply(
      request(prepared.previewId, ['flow']),
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).not.toBe('second\n');
  });

  it('a stale confirmation cannot apply or consume the authorization issued by a newer preview', () => {
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), 'first\n');
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    const first = preview(coordinator);
    writeFileSync(targetOf('flow', flowRel), 'second\n');
    const second = preview(coordinator);

    const stale = coordinator.apply({
      ...request(first.previewId, ['flow']),
    });
    expect(stale.ok).toBe(false);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).toBe('second\n');

    const current = coordinator.apply({
      ...request(second.previewId, ['flow']),
    });
    expect(current.ok).toBe(true);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).not.toBe(
      'second\n',
    );
  });

  it('refuses replacement for a destination that had no previewed conflict', () => {
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    const prepared = preview(coordinator);

    const result = coordinator.apply(
      request(prepared.previewId, ['flow']),
    );

    expect(result.ok).toBe(false);
    expect(existsSync(targetOf('flow', flowRel))).toBe(false);
  });

  it('preserves a target whose bytes changed after preview', () => {
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), 'mine-before\n');
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    const prepared = preview(coordinator);
    writeFileSync(targetOf('flow', flowRel), 'mine-after\n');

    const result = coordinator.apply(
      request(prepared.previewId, ['flow']),
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).toBe('mine-after\n');
  });

  it('preserves a target that appeared after preview', () => {
    const coordinator = createInstallExamplesCoordinator(() => dirs);
    const prepared = preview(coordinator);
    mkdirSync(targetDirOf('flow'), { recursive: true });
    writeFileSync(targetOf('flow', flowRel), 'appeared\n');

    const result = coordinator.apply(request(prepared.previewId));

    expect(result.ok).toBe(false);
    expect(readFileSync(targetOf('flow', flowRel), 'utf8')).toBe('appeared\n');
  });

  it('writes nothing when bundled source bytes change after preview', () => {
    const bundle = path.join(home, 'preview-source');
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, flowRel), 'source-before\n');
    const previewDirs = withBundle('flow', bundle);
    const coordinator = createInstallExamplesCoordinator(() => previewDirs);
    const prepared = preview(coordinator);
    writeFileSync(path.join(bundle, flowRel), 'source-after\n');

    const result = coordinator.apply(request(prepared.previewId));

    expect(result.ok).toBe(false);
    expect(existsSync(targetOf('flow', flowRel))).toBe(false);
  });

  it('writes nothing when the bundled file set shrinks after preview', () => {
    const bundle = path.join(home, 'preview-file-set');
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, 'first.md'), 'first\n');
    writeFileSync(path.join(bundle, 'second.md'), 'second\n');
    const previewDirs = withBundle('commands', bundle);
    const coordinator = createInstallExamplesCoordinator(() => previewDirs);
    const prepared = preview(coordinator);
    rmSync(path.join(bundle, 'second.md'));

    const result = coordinator.apply(request(prepared.previewId));

    expect(result.ok).toBe(false);
    expect(existsSync(targetDirOf('commands'))).toBe(false);
  });
});
