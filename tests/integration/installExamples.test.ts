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
  exampleInstallDirs,
  handleInstallExamplesPreview,
  handleInstallExamplesApply,
  type InstallDestination,
} from '../../src/main/installExamples';
import { loadFlowDefinitionLocalFirst } from '../../src/main/flow';
import { listTodoTemplates, loadTodoTemplateFile, parseTodoTemplate } from '../../src/main/todoTemplate';
import {
  SESSION_ID,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../../src/shared/ipc';

// Drive the real installer with real fs against the ACTUAL bundled example trees (§18.1/§26.5).
// Assertions are on the observable outcomes the ACs name — per-destination created/overwritten/skipped
// sets, byte-for-byte preservation on decline, all-or-nothing on an unwritable container — never on how
// the installer walks a tree. Every expected file set is enumerated FROM THE BUNDLE, never hard-coded:
// a hard-coded list silently under-installs the next bundle refresh.

const BUNDLE_FLOW = path.resolve('example', 'flow');
const BUNDLE_LOOPS = path.resolve('example', 'loops');
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
const LOOPS_SET = walk(BUNDLE_LOOPS);
const COMMANDS_SET = walk(BUNDLE_COMMANDS);
const LOOP_NAMES = readdirSync(BUNDLE_LOOPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
// Skills fan in: `<loop>/skills/<skill>/…` from EVERY bundled loop lands under one shared skills root.
const SKILLS_SET = LOOP_NAMES.flatMap((loop) => walk(path.join(BUNDLE_LOOPS, loop, 'skills')));

let home: string;
let configRoot: string;
let dirs: InstallDestination[];

const flowRel = 'flow.yaml';
const templateRel = path.join('todo-templates', 'ticket-grooming.md');
const planDefRel = path.join('plan-loop', 'plan-loop.yaml');
const skillRel = path.join('review-intent', 'SKILL.md');
const commandRel = 'groom-ticket.md';

// The real bundle resolves from cwd (path.resolve('example', …)), so appPath: process.cwd() yields the
// actual bundled trees; home/configRoot give the temp install targets. Tests that need a broken bundle
// swap one destination's bundleDir with withBundle — the opaque plan strategy travels untouched.
const seam = (): InstallDestination[] => exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, configRoot);
const destOf = (id: InstallDestinationId): InstallDestination => dirs.find((d) => d.id === id) as InstallDestination;
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

const ALL: InstallDestinationId[] = ['flow', 'loops', 'skills', 'commands'];
const targetOf = (id: InstallDestinationId, rel: string): string => path.join(destOf(id).targetDir, rel);
const filesFor = (
  groups: { destination: InstallDestinationId; files: string[] }[],
  id: InstallDestinationId,
): string[] => groups.find((g) => g.destination === id)?.files ?? [];
const okOf = (res: InstallExamplesResult): Extract<InstallExamplesResult, { ok: true }> => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`);
  return res;
};
const previewOk = (res: InstallExamplesPreview): InstallDestinationPreview[] => {
  if (!res.ok) throw new Error(`expected a preview, got error: ${res.error}`);
  return res.destinations;
};
const conflictsFor = (res: InstallExamplesPreview, id: InstallDestinationId): string[] => {
  const d = previewOk(res).find((x) => x.destination === id);
  return d && d.conflict ? [...d.files] : [];
};

describe('applyInstallExamples — a clean run seeds every destination and reports each file under it', () => {
  it('reports every bundled file created under the destination it was written to', () => {
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(filesFor(res.created, 'loops').sort()).toEqual([...LOOPS_SET].sort());
    expect(filesFor(res.created, 'skills').sort()).toEqual([...SKILLS_SET].sort());
    expect(filesFor(res.created, 'commands').sort()).toEqual([...COMMANDS_SET].sort());
    expect(res.overwritten).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it('writes bytes identical to the bundle at every destination', () => {
    applyInstallExamples(dirs, []);
    expect(readFileSync(targetOf('flow', flowRel))).toEqual(readFileSync(path.join(BUNDLE_FLOW, flowRel)));
    expect(readFileSync(targetOf('loops', planDefRel))).toEqual(readFileSync(path.join(BUNDLE_LOOPS, planDefRel)));
    expect(readFileSync(targetOf('skills', skillRel))).toEqual(
      readFileSync(path.join(BUNDLE_LOOPS, 'plan-loop', 'skills', skillRel)),
    );
    expect(readFileSync(targetOf('commands', commandRel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, commandRel)));
  });

  it('gives a loop directory a file at every relative path its bundled directory has (§26.5)', () => {
    applyInstallExamples(dirs, []);
    for (const loop of LOOP_NAMES) {
      for (const rel of walk(path.join(BUNDLE_LOOPS, loop))) {
        const installed = path.join(destOf('loops').targetDir, loop, rel);
        expect(existsSync(installed)).toBe(true);
        expect(readFileSync(installed)).toEqual(readFileSync(path.join(BUNDLE_LOOPS, loop, rel)));
      }
    }
  });

  it('seeds every bundled command, misses none, and holds exactly one file per command name', () => {
    applyInstallExamples(dirs, []);
    expect(COMMANDS_SET.length).toBeGreaterThan(0);
    for (const rel of COMMANDS_SET) {
      expect(readFileSync(path.join(destOf('commands').targetDir, rel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, rel)));
    }
    expect(walk(destOf('commands').targetDir).sort()).toEqual([...COMMANDS_SET].sort());
  });

  it('seeds no command into the flow home', () => {
    applyInstallExamples(dirs, []);
    for (const rel of COMMANDS_SET) expect(existsSync(path.join(destOf('flow').targetDir, rel))).toBe(false);
    expect(existsSync(path.join(destOf('flow').targetDir, 'commands'))).toBe(false);
  });

  it('installs the flow destination as flow.yaml + .md templates only — never a bare recursive walk', () => {
    applyInstallExamples(dirs, []);
    expect(walk(destOf('flow').targetDir).sort()).toEqual([...FLOW_SET].sort());
  });

  it('reports a file name occurring in two loop definitions as two distinct entries', () => {
    const shared = LOOPS_SET.filter((r) => r.startsWith(`${LOOP_NAMES[0]}${path.sep}`))
      .map((r) => path.relative(LOOP_NAMES[0], r))
      .filter((r) => LOOPS_SET.includes(path.join(LOOP_NAMES[1], r)));
    expect(shared.length).toBeGreaterThan(0); // the bundle really does share names across definitions

    const created = filesFor(okOf(applyInstallExamples(dirs, [])).created, 'loops');
    for (const rel of shared) {
      expect(created).toContain(path.join(LOOP_NAMES[0], rel));
      expect(created).toContain(path.join(LOOP_NAMES[1], rel));
    }
  });

  it('reports a file seeded to two destinations once under each, distinguishably', () => {
    const res = okOf(applyInstallExamples(dirs, []));
    const underLoops = filesFor(res.created, 'loops');
    const underSkills = filesFor(res.created, 'skills');
    expect(underSkills).toContain(skillRel);
    expect(underLoops).toContain(path.join('plan-loop', 'skills', skillRel));
    // Same bytes, two destinations, two entries — and the entries are not interchangeable.
    expect(underLoops).not.toContain(skillRel);
    expect(existsSync(targetOf('skills', skillRel))).toBe(true);
    expect(existsSync(targetOf('loops', path.join('plan-loop', 'skills', skillRel)))).toBe(true);
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
    mkdirSync(destOf('skills').targetDir, { recursive: true });
    mkdirSync(path.dirname(targetOf('skills', skillRel)), { recursive: true });
    writeFileSync(targetOf('skills', skillRel), 'my own skill\n');
    mkdirSync(destOf('commands').targetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'my own command\n');

    const preview = previewInstallExamples(dirs);
    expect(conflictsFor(preview, 'skills')).toEqual([skillRel]);
    expect(conflictsFor(preview, 'commands')).toEqual([commandRel]);
    expect(conflictsFor(preview, 'flow')).toEqual([]);
    expect(conflictsFor(preview, 'loops')).toEqual([]);
  });
});

describe('applyInstallExamples — one replace decision per destination, never one covering two', () => {
  function seedConflicts(): { skillBody: string; commandBody: string; flowBody: string } {
    const skillBody = 'my own skill\n';
    const commandBody = 'my own command\n';
    const flowBody = 'name: my-custom-flow\nsteps: []\n';
    mkdirSync(path.dirname(targetOf('skills', skillRel)), { recursive: true });
    writeFileSync(targetOf('skills', skillRel), skillBody);
    mkdirSync(destOf('commands').targetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), commandBody);
    mkdirSync(destOf('flow').targetDir, { recursive: true });
    writeFileSync(targetOf('flow', flowRel), flowBody);
    return { skillBody, commandBody, flowBody };
  }

  it('replaces in the consented destination and leaves the declined one byte-for-byte unchanged', () => {
    const { skillBody, commandBody } = seedConflicts();
    const res = okOf(applyInstallExamples(dirs, ['commands']));

    expect(filesFor(res.overwritten, 'commands')).toContain(commandRel);
    expect(filesFor(res.skipped, 'skills')).toContain(skillRel);
    expect(readFileSync(targetOf('commands', commandRel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, commandRel)));
    expect(readFileSync(targetOf('skills', skillRel), 'utf8')).toBe(skillBody);
    expect(commandBody).not.toBe(readFileSync(targetOf('commands', commandRel), 'utf8'));
  });

  it('replaces in the skills destination while declining commands — the mirror decision', () => {
    const { skillBody, commandBody } = seedConflicts();
    const res = okOf(applyInstallExamples(dirs, ['skills']));

    expect(filesFor(res.overwritten, 'skills')).toContain(skillRel);
    expect(filesFor(res.skipped, 'commands')).toContain(commandRel);
    expect(readFileSync(targetOf('commands', commandRel), 'utf8')).toBe(commandBody);
    expect(readFileSync(targetOf('skills', skillRel), 'utf8')).not.toBe(skillBody);
  });

  it('leaves a pre-existing skill file untouched on decline, whatever produced it', () => {
    const { skillBody } = seedConflicts();
    okOf(applyInstallExamples(dirs, []));
    expect(readFileSync(targetOf('skills', skillRel), 'utf8')).toBe(skillBody);
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
    rmSync(targetOf('flow', flowRel)); // flow home is clean; skills + commands still conflict
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(existsSync(targetOf('flow', flowRel))).toBe(true);
  });

  it('creates absent files in a declined destination — a decline withholds no creation', () => {
    mkdirSync(destOf('commands').targetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'mine\n');
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.skipped, 'commands')).toEqual([commandRel]);
    expect(filesFor(res.created, 'loops').sort()).toEqual([...LOOPS_SET].sort());
  });

  it('reports every file skipped and surfaces no conflict on a second identical run', () => {
    applyInstallExamples(dirs, []);
    const res = okOf(applyInstallExamples(dirs, []));
    expect(res.created).toEqual([]);
    expect(res.overwritten).toEqual([]);
    expect(filesFor(res.skipped, 'flow').sort()).toEqual([...FLOW_SET].sort());
    expect(filesFor(res.skipped, 'loops').sort()).toEqual([...LOOPS_SET].sort());
    expect(filesFor(res.skipped, 'skills').sort()).toEqual([...SKILLS_SET].sort());
    expect(filesFor(res.skipped, 'commands').sort()).toEqual([...COMMANDS_SET].sort());
    for (const d of previewOk(previewInstallExamples(dirs))) expect(d.conflict).toBe(false);
  });
});

describe('applyInstallExamples — all-or-nothing across destinations when unwritability is detectable', () => {
  it.skipIf(asRoot).each(ALL)(
    'writes nothing anywhere when the %s container resolves somewhere unwritable',
    (id) => {
      // The destination roots are app-derived, so a link the user placed at one is followed to its real
      // location (see the dotfiles describe below). What must still refuse UP FRONT is a root that cannot
      // be written — including one reached through the user's own link. Seeding the loops directory grants
      // `exec` authority (§26.6/CWE-829), so this gate protects an execution-authority boundary.
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
    mkdirSync(destOf('skills').targetDir, { recursive: true });
    chmodSync(destOf('skills').targetDir, 0o500); // readable + traversable, not writable
    try {
      const res = applyInstallExamples(dirs, []);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      expect(existsSync(targetOf('flow', flowRel))).toBe(false);
      expect(existsSync(targetOf('loops', planDefRel))).toBe(false);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
    } finally {
      chmodSync(destOf('skills').targetDir, 0o700);
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
    ['an ancestor two levels below the destination', path.join('plan-loop', 'skills')],
  ])('refuses when %s under the loops destination is a symlink, and writes nothing anywhere', (_label, rel) => {
    const real = mkdtempSync(path.join(tmpdir(), 'link-target-'));
    try {
      const link = path.join(destOf('loops').targetDir, rel);
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
      expect(existsSync(destOf('flow').targetDir)).toBe(false);
      expect(existsSync(destOf('skills').targetDir)).toBe(false);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('applyInstallExamples — a container symlink that stays inside the destination is followed, not refused (CWE-59 confinement)', () => {
  // The write path routes through the shared confinement primitive (confinedPath.ts): a container
  // symlink is refused ONLY when it escapes the destination (the tests above), and one that resolves to
  // a real location INSIDE the destination is followed to that symlink-free location (CWE-367) — the same
  // policy every other confined path in the app applies, rather than a blanket refusal of any symlink.
  it('writes a loop whose directory links to a real sibling inside the destination, at the resolved location', () => {
    const loopsTarget = destOf('loops').targetDir;
    mkdirSync(loopsTarget, { recursive: true });
    const realDir = path.join(loopsTarget, 'real-plan');
    mkdirSync(realDir);
    symlinkSync(realDir, path.join(loopsTarget, 'plan-loop'));

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // plan-loop/plan-loop.yaml resolves through the in-jail link to real-plan/plan-loop.yaml.
    expect(existsSync(path.join(realDir, 'plan-loop.yaml'))).toBe(true);
    expect(readFileSync(path.join(realDir, 'plan-loop.yaml'))).toEqual(readFileSync(path.join(BUNDLE_LOOPS, planDefRel)));
  });
});

describe('applyInstallExamples — first run seeds a config root that does not exist yet', () => {
  it('creates the whole tree when the user-config root is absent (a fresh machine)', () => {
    rmSync(configRoot, { recursive: true, force: true }); // ~/.claude has never been created
    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(targetOf('loops', planDefRel))).toBe(true);
    expect(existsSync(targetOf('skills', skillRel))).toBe(true);
    expect(existsSync(targetOf('commands', commandRel))).toBe(true);
  });
});

describe('applyInstallExamples — a failure once writing has begun names everything already written', () => {
  it('reports every created/overwritten file, and no file outside that list differs from its pre-action bytes', () => {
    // A directory standing where a command file must be written: the pre-flight (a container check)
    // cannot see it, so the failure lands mid-write, after flow/loops/skills are on disk.
    mkdirSync(path.join(destOf('commands').targetDir, commandRel), { recursive: true });
    // A pre-action file the run will skip (declined), so `no file outside that list` has a real member
    // whose bytes can be compared rather than a vacuously empty set.
    const preserved = targetOf('skills', skillRel);
    const preservedBytes = 'my own skill\n';
    mkdirSync(path.dirname(preserved), { recursive: true });
    writeFileSync(preserved, preservedBytes);

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
    // The failure arm still names what it left alone: the declined skill was correctly skipped, and a
    // caller reconciling the outcome must be able to see that, not infer it from silence.
    expect(filesFor(res.skipped, 'skills')).toContain(skillRel);

    const named = new Set(
      ALL.flatMap((id) => [...filesFor(res.created, id), ...filesFor(res.overwritten, id)].map((r) => targetOf(id, r))),
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
    for (const dir of [home, configRoot, destOf('flow').targetDir, destOf('loops').targetDir, destOf('skills').targetDir, destOf('commands').targetDir]) {
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
    mkdirSync(destOf('flow').targetDir, { recursive: true });
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
      mkdirSync(destOf('flow').targetDir, { recursive: true });
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

  it('skips a symlink planted in the bundle rather than reading through it (CWE-59)', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-link-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-bundle-'));
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'not part of the bundle\n');
      mkdirSync(path.join(outside, 'secret-dir'), { recursive: true });
      writeFileSync(path.join(outside, 'secret-dir', 'nested.md'), 'nor is this\n');
      writeFileSync(path.join(bundleX, commandRel), 'a real bundled command\n');
      symlinkSync(path.join(outside, 'secret.md'), path.join(bundleX, 'linked.md'));
      symlinkSync(path.join(outside, 'secret-dir'), path.join(bundleX, 'linked-dir'));

      const res = okOf(applyInstallExamples(withBundle('commands', bundleX), []));
      expect(filesFor(res.created, 'commands')).toEqual([commandRel]);
      expect(walk(destOf('commands').targetDir)).toEqual([commandRel]);
      expect(existsSync(path.join(destOf('commands').targetDir, 'linked.md'))).toBe(false);
      expect(existsSync(path.join(destOf('commands').targetDir, 'linked-dir'))).toBe(false);
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
      expect(load.definition.name).toBe('feature-dev');
      expect(load.definition.steps.map((s) => s.id)).toEqual(['groom-ticket', 'plan', 'implement', 'polish', 'copilot']);
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

  it.each(['loops', 'skills', 'commands', 'flow'] as const)(
    'reports a failure when the %s bundle tree is missing from the build',
    (id) => {
      const res = applyInstallExamples(withBundle(id, absent), []);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('bundle');
    },
  );

  it('refuses before writing anything, so a mispackaged build seeds no destination at all', () => {
    expect(applyInstallExamples(withBundle('loops', absent), []).ok).toBe(false);
    for (const id of ALL) expect(existsSync(destOf(id).targetDir)).toBe(false);
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
    const loops = destOf('loops').targetDir;
    const nested = path.join(loops, 'plan-loop');
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
    expect(existsSync(destOf('flow').targetDir)).toBe(false);
    expect(existsSync(destOf('commands').targetDir)).toBe(false);
  });
});

describe('a destination root the USER symlinked is followed, not refused — it is their config, not a planted link', () => {
  // The four destination roots are derived by the APP (home / CLAUDE_CONFIG_DIR); they are never read out
  // of untrusted content. Symlinking ~/.claude/skills into a dotfiles repo is a standard stow-style setup,
  // and Claude Code READS through it — so refusing to WRITE through it seeds nothing the reader will load,
  // strands the user with no route out, and blames them for an attack. Confinement still holds INSIDE the
  // resolved root.
  let dotfiles: string;
  beforeEach(() => {
    dotfiles = mkdtempSync(path.join(tmpdir(), 'install-dotfiles-'));
  });
  afterEach(() => {
    rmSync(dotfiles, { recursive: true, force: true });
  });

  const linkDest = (id: InstallDestinationId, real: string): void => {
    mkdirSync(real, { recursive: true });
    mkdirSync(path.dirname(destOf(id).targetDir), { recursive: true });
    symlinkSync(real, destOf(id).targetDir);
  };

  it('installs through the symlink, landing the files at the resolved location', () => {
    const real = path.join(dotfiles, 'skills');
    linkDest('skills', real);
    const res = okOf(applyInstallExamples(dirs, []));
    expect(filesFor(res.created, 'skills').sort()).toEqual([...SKILLS_SET].sort());
    expect(readFileSync(path.join(real, skillRel))).toEqual(
      readFileSync(path.join(BUNDLE_LOOPS, 'plan-loop', 'skills', skillRel)),
    );
  });

  it('still refuses a symlink INSIDE the resolved root that escapes it (CWE-59)', () => {
    const real = path.join(dotfiles, 'loops');
    const outside = path.join(dotfiles, 'outside');
    linkDest('loops', real);
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
    const locked = path.join(destOf('skills').targetDir, path.dirname(skillRel));
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
  // The bundle is a tree the build ships, not a text corpus: a skill or command may legitimately carry a
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
      mkdirSync(destOf('commands').targetDir, { recursive: true });
      symlinkSync(secret, targetOf('commands', commandRel));

      const res = handleInstallExamplesPreview({ sessionId: SESSION_ID }, () => dirs);
      expect(res.ok).toBe(false);
      expect(readFileSync(secret, 'utf8')).toBe('a file outside every destination\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)('reports an unreadable target as a refusal instead of throwing out of the handler', () => {
    mkdirSync(destOf('flow').targetDir, { recursive: true });
    const tf = targetOf('flow', flowRel);
    writeFileSync(tf, 'name: my-custom-flow\nsteps: []\n');
    chmodSync(tf, 0o000); // present but unreadable → classify's read throws EACCES, not ENOENT
    let res: ReturnType<typeof handleInstallExamplesPreview> | undefined;
    try {
      expect(() => {
        res = handleInstallExamplesPreview({ sessionId: SESSION_ID }, () => dirs);
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

describe('handleInstallExamplesPreview / handleInstallExamplesApply — contract guards (§6)', () => {
  const thunk = (): InstallDestination[] => dirs;

  it('applies for a valid live-session request', () => {
    const res = handleInstallExamplesApply({ sessionId: SESSION_ID, replace: [] }, thunk);
    expect(res.ok).toBe(true);
    expect(existsSync(targetOf('flow', flowRel))).toBe(true);
    expect(existsSync(targetOf('loops', planDefRel))).toBe(true);
  });

  it('rejects a wrong-session apply with an error and performs no filesystem work', () => {
    let consulted = 0;
    const res = handleInstallExamplesApply({ sessionId: 'nope', replace: ['flow'] }, () => {
      consulted++;
      return dirs;
    });
    expect(res.ok).toBe(false);
    expect(consulted).toBe(0);
    expect(existsSync(destOf('flow').targetDir)).toBe(false);
  });

  it('rejects an apply whose replace list is missing or holds an unknown destination', () => {
    expect(handleInstallExamplesApply({ sessionId: SESSION_ID }, thunk).ok).toBe(false);
    expect(handleInstallExamplesApply({ sessionId: SESSION_ID, replace: ['everything'] }, thunk).ok).toBe(false);
    expect(existsSync(destOf('flow').targetDir)).toBe(false);
  });

  it('previews conflicts for a live session and refuses a wrong session with an error, not an empty list', () => {
    mkdirSync(destOf('commands').targetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'mine\n');
    const live = handleInstallExamplesPreview({ sessionId: SESSION_ID }, thunk);
    expect(live.ok).toBe(true);
    expect(conflictsFor(live, 'commands')).toEqual([commandRel]);
    // A refused request is distinguishable from a clean preview: it carries an error, not { destinations: [] }.
    expect(handleInstallExamplesPreview({ sessionId: 'nope' }, thunk).ok).toBe(false);
  });
});
