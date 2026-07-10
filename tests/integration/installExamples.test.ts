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
  handleInstallExamplesPreview,
  handleInstallExamplesApply,
  type ExampleDirs,
} from '../../src/main/installExamples';
import { loadFlowDefinitionLocalFirst } from '../../src/main/flow';
import { listTodoTemplates, loadTodoTemplateFile, parseTodoTemplate } from '../../src/main/todoTemplate';
import { userConfigLoopsDir, userConfigSkillsDir, userConfigCommandsDir } from '../../src/main/userConfig';
import { SESSION_ID, type InstallDestinationId, type InstallExamplesResult } from '../../src/shared/ipc';

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
let dirs: ExampleDirs;

const flowRel = 'flow.yaml';
const templateRel = path.join('todo-templates', 'ticket-grooming.md');
const planDefRel = path.join('plan-loop', 'plan-loop.yaml');
const skillRel = path.join('review-intent', 'SKILL.md');
const commandRel = 'groom-ticket.md';

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'install-examples-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'install-examples-cfg-'));
  dirs = {
    flowBundleDir: BUNDLE_FLOW,
    flowTargetDir: path.join(home, '.agent-terminal'),
    loopsBundleDir: BUNDLE_LOOPS,
    loopsTargetDir: userConfigLoopsDir(configRoot),
    skillsTargetDir: userConfigSkillsDir(configRoot),
    commandsBundleDir: BUNDLE_COMMANDS,
    commandsTargetDir: userConfigCommandsDir(configRoot),
  };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

const ALL: InstallDestinationId[] = ['flow', 'loops', 'skills', 'commands'];
const targetOf = (id: InstallDestinationId, rel: string): string =>
  path.join(
    { flow: dirs.flowTargetDir, loops: dirs.loopsTargetDir, skills: dirs.skillsTargetDir, commands: dirs.commandsTargetDir }[id],
    rel,
  );
const filesFor = (
  groups: { destination: InstallDestinationId; files: string[] }[],
  id: InstallDestinationId,
): string[] => groups.find((g) => g.destination === id)?.files ?? [];
const okOf = (res: InstallExamplesResult): Extract<InstallExamplesResult, { ok: true }> => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`);
  return res;
};
const conflictsFor = (
  preview: ReturnType<typeof previewInstallExamples>,
  id: InstallDestinationId,
): string[] => {
  const d = preview.destinations.find((x) => x.destination === id);
  return d && d.conflict ? d.files : [];
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
        const installed = path.join(dirs.loopsTargetDir, loop, rel);
        expect(existsSync(installed)).toBe(true);
        expect(readFileSync(installed)).toEqual(readFileSync(path.join(BUNDLE_LOOPS, loop, rel)));
      }
    }
  });

  it('seeds every bundled command, misses none, and holds exactly one file per command name', () => {
    applyInstallExamples(dirs, []);
    expect(COMMANDS_SET.length).toBeGreaterThan(0);
    for (const rel of COMMANDS_SET) {
      expect(readFileSync(path.join(dirs.commandsTargetDir, rel))).toEqual(readFileSync(path.join(BUNDLE_COMMANDS, rel)));
    }
    expect(walk(dirs.commandsTargetDir).sort()).toEqual([...COMMANDS_SET].sort());
  });

  it('seeds no command into the flow home', () => {
    applyInstallExamples(dirs, []);
    for (const rel of COMMANDS_SET) expect(existsSync(path.join(dirs.flowTargetDir, rel))).toBe(false);
    expect(existsSync(path.join(dirs.flowTargetDir, 'commands'))).toBe(false);
  });

  it('installs the flow destination as flow.yaml + .md templates only — never a bare recursive walk', () => {
    applyInstallExamples(dirs, []);
    expect(walk(dirs.flowTargetDir).sort()).toEqual([...FLOW_SET].sort());
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
    const preview = previewInstallExamples(dirs);
    for (const id of ALL) expect(preview.destinations.find((d) => d.destination === id)?.conflict).toBe(false);
  });

  it('creates no file and no directory in any destination', () => {
    previewInstallExamples(dirs);
    for (const id of ALL) expect(existsSync(targetOf(id, '.'))).toBe(false);
  });

  it('reports no conflict when every present target is byte-identical (never prompted twice)', () => {
    applyInstallExamples(dirs, []);
    const preview = previewInstallExamples(dirs);
    for (const id of ALL) expect(preview.destinations.find((d) => d.destination === id)?.conflict).toBe(false);
  });

  it('reports exactly the differing targets, grouped under their own destination', () => {
    mkdirSync(dirs.skillsTargetDir, { recursive: true });
    mkdirSync(path.dirname(targetOf('skills', skillRel)), { recursive: true });
    writeFileSync(targetOf('skills', skillRel), 'my own skill\n');
    mkdirSync(dirs.commandsTargetDir, { recursive: true });
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
    mkdirSync(dirs.commandsTargetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), commandBody);
    mkdirSync(dirs.flowTargetDir, { recursive: true });
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
    mkdirSync(dirs.commandsTargetDir, { recursive: true });
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
    for (const d of previewInstallExamples(dirs).destinations) expect(d.conflict).toBe(false);
  });
});

describe('applyInstallExamples — all-or-nothing across destinations when unwritability is detectable', () => {
  it.each(ALL)('writes nothing anywhere when the %s container is a symlink (CWE-59)', (id) => {
    // Plant the destination's container as a symlink to a real directory elsewhere. The write must be
    // refused up front — nothing through the link, nothing in the link target, nothing in any sibling
    // destination. Seeding the loops directory grants `exec` authority (§26.6/CWE-829), so this guard
    // protects an execution-authority boundary, not merely a config directory.
    const target = targetOf(id, '.');
    const real = mkdtempSync(path.join(tmpdir(), 'link-target-'));
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(real, target);

      const res = applyInstallExamples(dirs, ALL);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBeTruthy();
      expect(res.created).toEqual([]);
      expect(res.overwritten).toEqual([]);
      expect(walk(real)).toEqual([]); // nothing written through the link
      for (const other of ALL.filter((o) => o !== id)) expect(walk(targetOf(other, '.'))).toEqual([]);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)('writes nothing anywhere when a destination container is not writable', () => {
    mkdirSync(dirs.skillsTargetDir, { recursive: true });
    chmodSync(dirs.skillsTargetDir, 0o500); // readable + traversable, not writable
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
      chmodSync(dirs.skillsTargetDir, 0o700);
    }
  });
});

describe('applyInstallExamples — a symlink nested inside a destination is refused mid-write (CWE-59)', () => {
  it.each([
    ["the file's own container", path.join('plan-loop', 'charter')],
    ['an intermediate ancestor', 'plan-loop'],
  ])('refuses when %s under the loops destination is a symlink', (_label, rel) => {
    const real = mkdtempSync(path.join(tmpdir(), 'link-target-'));
    try {
      const link = path.join(dirs.loopsTargetDir, rel);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(real, link);

      const res = applyInstallExamples(dirs, ALL);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('plan-loop');
      expect(walk(real)).toEqual([]); // nothing written through the link

      // Writing had already begun, and the result names exactly what landed before the refusal.
      expect(filesFor(res.created, 'flow').sort()).toEqual([...FLOW_SET].sort());
      const namedLoops = [...filesFor(res.created, 'loops'), ...filesFor(res.overwritten, 'loops')];
      expect(namedLoops.length).toBeGreaterThan(0);
      expect(namedLoops.filter((r) => r.startsWith(`plan-loop${path.sep}`))).toEqual([]);
      expect(filesFor(res.created, 'skills')).toEqual([]);
      expect(filesFor(res.created, 'commands')).toEqual([]);
      expect(existsSync(targetOf('commands', commandRel))).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('applyInstallExamples — a failure once writing has begun names everything already written', () => {
  it('reports every created/overwritten file, and no file outside that list differs from its pre-action bytes', () => {
    // A directory standing where a command file must be written: the pre-flight (a container check)
    // cannot see it, so the failure lands mid-write, after flow/loops/skills are on disk.
    mkdirSync(path.join(dirs.commandsTargetDir, commandRel), { recursive: true });

    const res = applyInstallExamples(dirs, []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();

    const named = new Set(
      ALL.flatMap((id) => [...filesFor(res.created, id), ...filesFor(res.overwritten, id)].map((r) => targetOf(id, r))),
    );
    expect(named.size).toBeGreaterThan(0); // writing really had begun

    for (const id of ALL) {
      for (const rel of walk(targetOf(id, '.'))) expect(named.has(targetOf(id, rel))).toBe(true);
    }
  });
});

describe('applyInstallExamples — never writes a .gitignore', () => {
  it('creates none anywhere it wrote', () => {
    applyInstallExamples(dirs, ALL);
    for (const dir of [home, configRoot, dirs.flowTargetDir, dirs.loopsTargetDir, dirs.skillsTargetDir, dirs.commandsTargetDir]) {
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
    mkdirSync(dirs.flowTargetDir, { recursive: true });
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
      mkdirSync(dirs.flowTargetDir, { recursive: true });
      writeFileSync(targetOf('flow', flowRel), 'name: my-custom-flow\nsteps: []\n'); // present → bundle read reached
      let res: InstallExamplesResult | undefined;
      expect(() => {
        res = applyInstallExamples({ ...dirs, flowBundleDir: bundleEmpty }, ['flow']);
      }).not.toThrow();
      expect(res?.ok).toBe(false);
      if (!res || res.ok) return;
      expect(res.error).toBeTruthy();
    } finally {
      rmSync(bundleEmpty, { recursive: true, force: true });
    }
  });

  it('installs only .md todo templates, never a non-.md flow bundle asset (§18.6)', () => {
    const bundleX = mkdtempSync(path.join(tmpdir(), 'bundle-nonmd-'));
    try {
      writeFileSync(path.join(bundleX, flowRel), readFileSync(path.join(BUNDLE_FLOW, flowRel)));
      mkdirSync(path.join(bundleX, 'todo-templates'), { recursive: true });
      writeFileSync(path.join(bundleX, 'todo-templates', 'ticket-grooming.md'), '# t\n- [ ] x\n');
      writeFileSync(path.join(bundleX, 'todo-templates', 'asset.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x90]));

      const res = okOf(applyInstallExamples({ ...dirs, flowBundleDir: bundleX }, []));
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

describe('handleInstallExamplesPreview / handleInstallExamplesApply — contract guards (§6)', () => {
  const seam = (): ExampleDirs => dirs;

  it('applies for a valid live-session request', () => {
    const res = handleInstallExamplesApply({ sessionId: SESSION_ID, replace: [] }, seam);
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
    expect(existsSync(dirs.flowTargetDir)).toBe(false);
  });

  it('rejects an apply whose replace list is missing or holds an unknown destination', () => {
    expect(handleInstallExamplesApply({ sessionId: SESSION_ID }, seam).ok).toBe(false);
    expect(handleInstallExamplesApply({ sessionId: SESSION_ID, replace: ['everything'] }, seam).ok).toBe(false);
    expect(existsSync(dirs.flowTargetDir)).toBe(false);
  });

  it('previews conflicts for a live session and returns nothing for a wrong session', () => {
    mkdirSync(dirs.commandsTargetDir, { recursive: true });
    writeFileSync(targetOf('commands', commandRel), 'mine\n');
    expect(conflictsFor(handleInstallExamplesPreview({ sessionId: SESSION_ID }, seam), 'commands')).toEqual([commandRel]);
    expect(handleInstallExamplesPreview({ sessionId: 'nope' }, seam).destinations).toEqual([]);
  });
});
