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
import { SESSION_ID } from '../../src/shared/ipc';

// Drive the real installer with real fs against the ACTUAL bundled example flow (§18.1). Assertions are
// on the observable outcomes the ACs name — created/overwritten/skipped sets, byte-for-byte preservation
// on decline, conflict detection only on exist-and-differ, and renderability of the installed bytes —
// never on how the installer walks the tree.

const BUNDLE = path.resolve('example', 'flow');
const TEMPLATE_COUNT = readdirSync(path.join(BUNDLE, 'todo-templates')).filter((f) => f.endsWith('.md')).length;
const FILE_COUNT = TEMPLATE_COUNT + 1; // flow.yaml + every template

let home: string;
let targetDir: string; // the global flow home <home>/.agent-terminal
const flowRel = 'flow.yaml';
const templateRel = path.join('todo-templates', 'ticket-grooming.md');

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'install-examples-'));
  targetDir = path.join(home, '.agent-terminal');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const targetOf = (rel: string): string => path.join(targetDir, rel);

describe('applyInstallExamples — created-only into an empty home', () => {
  it('creates the flow definition and every template, reporting them all as created', () => {
    const res = applyInstallExamples(BUNDLE, targetDir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toHaveLength(FILE_COUNT);
    expect(res.overwritten).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.created).toContain(flowRel);
    expect(existsSync(targetOf(flowRel))).toBe(true);
    expect(existsSync(targetOf(templateRel))).toBe(true);
    // Installed bytes equal the bundle's.
    expect(readFileSync(targetOf(flowRel))).toEqual(readFileSync(path.join(BUNDLE, flowRel)));
  });

  it('installs only the flow + its templates — no loop, skill, or command sibling appears', () => {
    applyInstallExamples(BUNDLE, targetDir, false);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(targetDir, path.join(dir, e.name))],
      );
    const installed = walk(targetDir);
    for (const rel of installed) {
      expect(rel === flowRel || rel.startsWith(`todo-templates${path.sep}`)).toBe(true);
    }
    expect(installed.some((r) => /loop|skill|command|groom-ticket\.md/.test(r) && !r.startsWith('todo-templates'))).toBe(false);
  });
});

describe('previewInstallExamples — conflicts iff a target exists and differs', () => {
  it('is empty when the home is clean', () => {
    expect(previewInstallExamples(BUNDLE, targetDir).conflicts).toEqual([]);
  });

  it('is empty when every present target is byte-identical (never a conflict, never prompted)', () => {
    applyInstallExamples(BUNDLE, targetDir, false); // now identical
    expect(previewInstallExamples(BUNDLE, targetDir).conflicts).toEqual([]);
  });

  it('reports exactly the targets that exist and differ', () => {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetOf(flowRel), 'name: my-custom-flow\nsteps: []\n'); // differs from the bundle
    expect(previewInstallExamples(BUNDLE, targetDir).conflicts).toEqual([flowRel]);
  });
});

describe('applyInstallExamples — the overwrite decision governs only exist-and-differ targets', () => {
  it('leaves a differing target byte-for-byte unchanged and reports it skipped when declining', () => {
    mkdirSync(targetDir, { recursive: true });
    const custom = 'name: my-custom-flow\nsteps: []\n';
    writeFileSync(targetOf(flowRel), custom);

    const res = applyInstallExamples(BUNDLE, targetDir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toContain(flowRel);
    expect(res.created).not.toContain(flowRel);
    expect(readFileSync(targetOf(flowRel), 'utf8')).toBe(custom); // untouched
  });

  it('replaces a differing target and reports it overwritten when opting in', () => {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetOf(flowRel), 'name: my-custom-flow\nsteps: []\n');

    const res = applyInstallExamples(BUNDLE, targetDir, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.overwritten).toContain(flowRel);
    expect(readFileSync(targetOf(flowRel))).toEqual(readFileSync(path.join(BUNDLE, flowRel)));
  });

  it('skips a byte-identical target regardless of the decision', () => {
    applyInstallExamples(BUNDLE, targetDir, false); // identical now
    const res = applyInstallExamples(BUNDLE, targetDir, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toHaveLength(FILE_COUNT);
    expect(res.overwritten).toEqual([]);
    expect(res.created).toEqual([]);
  });

  it('creates absent targets even while declining to overwrite a differing one (no creation withheld)', () => {
    mkdirSync(targetDir, { recursive: true });
    const custom = 'name: my-custom-flow\nsteps: []\n';
    writeFileSync(targetOf(flowRel), custom); // present + differs; templates absent

    const res = applyInstallExamples(BUNDLE, targetDir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skipped).toEqual([flowRel]);
    expect(res.created).toHaveLength(TEMPLATE_COUNT); // every missing template created
    expect(readFileSync(targetOf(flowRel), 'utf8')).toBe(custom); // conflict left unchanged
    expect(existsSync(targetOf(templateRel))).toBe(true);
  });
});

describe('applyInstallExamples — a bundle without a todo-templates/ subdir installs flow-only', () => {
  it('installs and reports only the flow definition when the bundle has no todo-templates/', () => {
    const bundleOnlyFlow = mkdtempSync(path.join(tmpdir(), 'bundle-flow-only-'));
    try {
      writeFileSync(path.join(bundleOnlyFlow, flowRel), readFileSync(path.join(BUNDLE, flowRel)));
      const res = applyInstallExamples(bundleOnlyFlow, targetDir, false);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.created).toEqual([flowRel]);
      expect(res.overwritten).toEqual([]);
      expect(res.skipped).toEqual([]);
      expect(existsSync(targetOf(flowRel))).toBe(true);
      expect(existsSync(path.join(targetDir, 'todo-templates'))).toBe(false);
    } finally {
      rmSync(bundleOnlyFlow, { recursive: true, force: true });
    }
  });
});

describe('applyInstallExamples — never writes a .gitignore', () => {
  it('creates no .gitignore anywhere in the home', () => {
    applyInstallExamples(BUNDLE, targetDir, false);
    expect(existsSync(path.join(home, '.gitignore'))).toBe(false);
    expect(existsSync(path.join(targetDir, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged', () => {
    const gi = path.join(home, '.gitignore');
    const before = 'node_modules\n.env\n';
    writeFileSync(gi, before);
    applyInstallExamples(BUNDLE, targetDir, true);
    expect(readFileSync(gi, 'utf8')).toBe(before);
  });
});

describe('applyInstallExamples — a refused write is an error, never a silent skip', () => {
  it('reports an error (not skipped) when the container cannot be safely written (symlink, CWE-59)', () => {
    // Make the flow home a symlink to a real dir: atomicWriteFileSync refuses to follow it (returns
    // false). That must surface as an error, distinct from a decline-driven skip.
    const real = path.join(home, 'real-home');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, targetDir);
    const res = applyInstallExamples(BUNDLE, targetDir, false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
    expect(existsSync(path.join(real, flowRel))).toBe(false); // nothing written into the symlink target
  });

  it('refuses when the home is a symlink even if flow.yaml is skipped, so nested templates cannot escape (CWE-59)', () => {
    // A symlinked flow home whose flow.yaml is already byte-identical: flow.yaml is skipped, so the only
    // writes are the nested todo-templates. atomicWriteFileSync only guards each file's immediate
    // container, not a symlinked grandparent — so the install must refuse up front on the home itself.
    const real = path.join(home, 'real-home');
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, flowRel), readFileSync(path.join(BUNDLE, flowRel))); // identical → skipped
    symlinkSync(real, targetDir);

    const res = applyInstallExamples(BUNDLE, targetDir, false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
    expect(existsSync(path.join(real, 'todo-templates'))).toBe(false); // no nested write escaped into the symlink target
  });
});

describe('installed bytes are renderable by the runtime read path (§18.1/§18.6)', () => {
  it('loads through loadFlowDefinitionLocalFirst and yields every bundled step id', () => {
    applyInstallExamples(BUNDLE, targetDir, false);
    const localWithoutFlow = mkdtempSync(path.join(tmpdir(), 'no-local-flow-'));
    try {
      const load = loadFlowDefinitionLocalFirst(localWithoutFlow, home);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      expect(load.definition.name).toBe('feature-dev');
      expect(load.definition.steps.map((s) => s.id)).toEqual([
        'groom-ticket',
        'plan',
        'implement',
        'polish',
        'copilot',
      ]);
    } finally {
      rmSync(localWithoutFlow, { recursive: true, force: true });
    }
  });

  it('resolves every referenced todo_template in the installed todo-templates/ (§18.6)', () => {
    applyInstallExamples(BUNDLE, targetDir, false);
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
  const dirs = (): ExampleDirs => ({ bundleDir: BUNDLE, targetDir });

  it('applies for a valid live-session request', () => {
    const res = handleInstallExamplesApply({ sessionId: SESSION_ID, overwrite: false }, dirs);
    expect(res.ok).toBe(true);
    expect(existsSync(targetOf(flowRel))).toBe(true);
  });

  it('rejects a wrong-session apply with an error and performs no filesystem work', () => {
    let consulted = 0;
    const res = handleInstallExamplesApply({ sessionId: 'nope', overwrite: true }, () => {
      consulted++;
      return dirs();
    });
    expect(res.ok).toBe(false);
    expect(consulted).toBe(0);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('rejects an apply whose overwrite flag is missing/non-boolean', () => {
    const res = handleInstallExamplesApply({ sessionId: SESSION_ID }, dirs);
    expect(res.ok).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('previews conflicts for a live session and returns empty for a wrong session', () => {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetOf(flowRel), 'name: custom\nsteps: []\n');
    expect(handleInstallExamplesPreview({ sessionId: SESSION_ID }, dirs).conflicts).toEqual([flowRel]);
    expect(handleInstallExamplesPreview({ sessionId: 'nope' }, dirs).conflicts).toEqual([]);
  });
});
