import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseLoopDef,
  gateForStatus,
  reviewerRosterForPhase,
  normalizeConsolidatedVerdict,
} from '../../src/main/loopDef';

// §24.2.3 T2 (folded) / §18.1 — the read-only LoopDef resolver. Each gate's `id` IS a status string,
// carrying `human_options` + `kind`. Resolution mirrors `agent-loop list`: a repo `.agent-loop.yaml`
// `loops:` registry override wins, else `$CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml` (default ~/.claude).
// Like the §19.1 store it NEVER throws — missing / corrupt / wrong-schema / unknown-name degrades to null.

// A minimal real-shaped LoopDef: only the gate fields the app reads (engine's other keys omitted).
const IMPL_LOOP =
  'name: impl-loop\n' +
  'schema_version: "4"\n' +
  'gates:\n' +
  '  - id: awaiting-human-pr-approval\n' +
  '    kind: approve-required\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    next_status_on_approve: awaiting-team-review\n' +
  '  - id: awaiting-human-impl-triage\n' +
  '    kind: triage\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    next_status_on_approve: awaiting-team-review\n' +
  '  - id: awaiting-team-review\n' +
  '    kind: terminal\n' +
  '    human_options: []\n';

describe('LoopDef resolver (§24.2.3 T2 folded / §18.1)', () => {
  let repo: string;
  let configDir: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopdef-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'loopdef-config-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const writeRegistry = (mapping: string): void =>
    writeFileSync(join(repo, '.agent-loop.yaml'), `loops:\n${mapping}`);
  const writeConfigLoop = (name: string, body: string): void => {
    mkdirSync(join(configDir, 'loops', name), { recursive: true });
    writeFileSync(join(configDir, 'loops', name, `${name}.yaml`), body);
  };

  it('resolves a loop via the repo .agent-loop.yaml loops: registry override and reads its gates', () => {
    writeFileSync(join(repo, 'my-impl-loop.yaml'), IMPL_LOOP);
    writeRegistry('  impl-loop: ./my-impl-loop.yaml\n');
    const def = parseLoopDef(repo, 'impl-loop', configDir);
    expect(def?.name).toBe('impl-loop');
    expect(def?.gates).toContainEqual({
      id: 'awaiting-human-pr-approval',
      kind: 'approve-required',
      humanOptions: ['approve', 'request-changes', 'impasse'],
      terminal: false,
      onApprove: [],
      onRequestChanges: [],
      onImpasse: [],
      nextStatusOnApprove: 'awaiting-team-review',
      nextStatusOnRequestChanges: '',
      nextStatusOnImpasse: '',
    });
    const gate = gateForStatus(def!, 'awaiting-human-pr-approval');
    expect(gate?.humanOptions).toEqual(['approve', 'request-changes', 'impasse']);
  });

  it('flags a terminal gate (kind: terminal, empty human_options)', () => {
    writeConfigLoop('impl-loop', IMPL_LOOP);
    const def = parseLoopDef(repo, 'impl-loop', configDir);
    expect(gateForStatus(def!, 'awaiting-team-review')).toEqual({
      id: 'awaiting-team-review',
      kind: 'terminal',
      humanOptions: [],
      terminal: true,
      onApprove: [],
      onRequestChanges: [],
      onImpasse: [],
      nextStatusOnApprove: '',
      nextStatusOnRequestChanges: '',
      nextStatusOnImpasse: '',
    });
  });

  it('resolves from $CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml when no registry override exists', () => {
    writeConfigLoop('plan-loop', IMPL_LOOP.replace('name: impl-loop', 'name: plan-loop'));
    const def = parseLoopDef(repo, 'plan-loop', configDir);
    expect(def?.name).toBe('plan-loop');
    expect(def?.gates.length).toBe(3);
  });

  it('returns null (never throws) for an unknown loop name', () => {
    expect(parseLoopDef(repo, 'no-such-loop', configDir)).toBeNull();
  });

  it('refuses a loop NAME that is not a single safe path segment, even if it resolves to a real def (CWE-22)', () => {
    // The loop name (from flow.yaml `loop:`) selects the config-dir directory the def — and its
    // injected prompts (§26.5) — are read from. A `../`-laden name traverses out of <config>/loops; it
    // must be refused at the resolution boundary, mirroring the override-path containment check and the
    // phase/actor SAFE_NAME guard. Plant a valid def at the traversal target and assert it is NOT read.
    writeFileSync(join(configDir, 'evil-loop.yaml'), IMPL_LOOP.replace('name: impl-loop', 'name: evil-loop'));
    // path.join(<configDir>/loops, '../evil-loop', '../evil-loop.yaml') === <configDir>/evil-loop.yaml
    expect(parseLoopDef(repo, '../evil-loop', configDir)).toBeNull();
  });

  it('returns null for a corrupt LoopDef yaml', () => {
    writeConfigLoop('impl-loop', 'name: impl-loop\n  gates: : : broken\n\t- nope');
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('returns null for a LoopDef with the wrong schema_version', () => {
    writeConfigLoop('impl-loop', IMPL_LOOP.replace('schema_version: "4"', 'schema_version: "3"'));
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('returns null when the LoopDef has no gates array', () => {
    writeConfigLoop('impl-loop', 'name: impl-loop\nschema_version: "4"\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('ignores a repo registry override that escapes the repo dir (CWE-22 path traversal), falling through to config', () => {
    // A repo-escaping override must be refused (mirrors the todoTemplate loader, §20.2) and fall
    // through to the trusted config copy, not read+parse the escaped path.
    const outside = mkdtempSync(join(tmpdir(), 'loopdef-outside-'));
    writeFileSync(join(outside, 'evil.yaml'), IMPL_LOOP.replace('name: impl-loop', 'name: evil-loop'));
    writeConfigLoop('impl-loop', IMPL_LOOP); // the legit config copy

    writeRegistry(`  impl-loop: ${join(outside, 'evil.yaml')}\n`); // absolute escape
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');

    writeRegistry('  impl-loop: ../../../../../../etc/passwd\n'); // relative traversal escape
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');

    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses an in-repo symlink whose target escapes the repo (CWE-59), falling through to config', () => {
    // A symlink that LIVES inside the repo passes the lexical guard, so the realpath must also be
    // re-checked (mirrors the todoTemplate loader, §20.2): an in-repo link to an outside file is refused.
    const outside = mkdtempSync(join(tmpdir(), 'loopdef-outside-'));
    writeFileSync(join(outside, 'evil.yaml'), IMPL_LOOP.replace('name: impl-loop', 'name: evil-loop'));
    symlinkSync(join(outside, 'evil.yaml'), join(repo, 'link.yaml'));
    writeConfigLoop('impl-loop', IMPL_LOOP); // the legit config copy

    writeRegistry('  impl-loop: ./link.yaml\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');

    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a valid in-repo symlink override (reads the symlink target through the realpath)', () => {
    // A contained symlink to an in-repo LoopDef is legitimate and must be accepted (CWE-367-hardened,
    // mirroring readArtifact) — regression pin for the abs→real-path switch.
    writeFileSync(join(repo, 'real-impl-loop.yaml'), IMPL_LOOP);
    symlinkSync(join(repo, 'real-impl-loop.yaml'), join(repo, 'link.yaml'));
    writeRegistry('  impl-loop: ./link.yaml\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');
  });

  it('a dangling in-repo override resolves to null (does NOT fall through to the config copy)', () => {
    // A contained-but-missing override yields null (unreadable), distinct from a repo-ESCAPING
    // override which deliberately falls through to the trusted config copy.
    writeConfigLoop('impl-loop', IMPL_LOOP); // present, to prove we don't fall back to it
    writeRegistry('  impl-loop: ./not-created-yet.yaml\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('still honors an in-repo registry override in a subdirectory (containment guard is not over-broad)', () => {
    mkdirSync(join(repo, 'loops'), { recursive: true });
    writeFileSync(join(repo, 'loops', 'my-impl-loop.yaml'), IMPL_LOOP);
    writeRegistry('  impl-loop: ./loops/my-impl-loop.yaml\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');
  });
});

// §26.5 / §26.9 — the orchestrator drives in-app bootstrap (pickup) from the bound LoopDef's
// pickup_contract, never hardcoded. parseLoopDef therefore reads the contract's bootstrap-shaping
// fields and resolves each initial_labels slot to its concrete label string (config_bindings
// labels.pr / labels.issue maps). Validated against the REAL plan-loop def copied into example/loops.
describe('pickup_contract resolution (§26.5 / §26.9)', () => {
  // example/loops/<name>/<name>.yaml mirrors $CLAUDE_CONFIG_DIR/loops layout, so the example dir
  // serves as the configDir for resolution (configLoopsDir joins `loops`).
  const exampleConfigDir = resolve(__dirname, '..', '..', 'example');
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopdef-pickup-repo-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads the bootstrap-shaping fields from the real plan-loop pickup_contract', () => {
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    expect(def?.pickup).toMatchObject({
      initialStatus: 'plan-draft',
      initialBranchTpl: 'plan-loop/issue-{issue}',
      initialPrBodyRef: 'stub-pr-body',
      onConflict: 'wipe-and-retry',
    });
  });

  it('resolves each initial_labels slot to its concrete label string (target-scoped)', () => {
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    // ready/in_progress are issue slots; plan-draft is a pr slot — each resolves against its own map.
    expect(def?.pickup?.initialLabels).toEqual([
      { action: 'remove', label: 'plan-loop/ready', target: 'issue' },
      { action: 'add', label: 'plan-loop/in-progress', target: 'issue' },
      { action: 'add', label: 'plan-loop/plan-draft', target: 'pr' },
    ]);
  });

  it('parses the phase id + entry_status + post-verdict gate statuses the orchestrator branches on (§26.5/§26.6)', () => {
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    expect(def?.phases).toEqual([
      {
        id: 'plan',
        entryStatus: 'plan-draft',
        rosterOverrideId: '',
        postCleanGate: 'awaiting-human-plan-approval',
        postNeedsWorkGate: 'awaiting-human-plan-triage',
      },
    ]);
  });

  it('parses the consolidated verdict taxonomy so the orchestrator can normalize a read verdict (§26.5/§26.3 D45)', () => {
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    // The consolidator writes a canonical clean/needs-work verdict; a synonym or unknown string is
    // normalized against the LoopDef taxonomy, defaulting to needs-work (the strict-rule fallback, §26.3).
    expect(normalizeConsolidatedVerdict(def!, 'clean')).toBe('clean');
    expect(normalizeConsolidatedVerdict(def!, 'needs-work')).toBe('needs-work');
    expect(normalizeConsolidatedVerdict(def!, 'concerns')).toBe('needs-work'); // a mapped synonym
    expect(normalizeConsolidatedVerdict(def!, 'approved')).toBe('clean'); // a mapped synonym
    expect(normalizeConsolidatedVerdict(def!, 'CLEAN')).toBe('clean'); // case/space-insensitive
    expect(normalizeConsolidatedVerdict(def!, 'gibberish')).toBe('needs-work'); // unknown → strict fallback
  });

  it('resolves the reviewer roster for a phase from the real plan-loop def (§26.4/§26.5)', () => {
    // The fan-out roster (§26.4) is the phase's resolved roster's ordered actors — read from the
    // LoopDef, never hardcoded. plan-loop binds its default roster to the six judgment personas.
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    expect(reviewerRosterForPhase(def!, 'plan')).toEqual([
      'review-principal',
      'review-security',
      'review-architecture',
      'review-intent',
      'review-maintainability',
      'review-contracts',
    ]);
  });

  it('returns an empty roster for an unknown phase (degrades, never throws)', () => {
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    expect(reviewerRosterForPhase(def!, 'no-such-phase')).toEqual([]);
  });

  it('drops phase ids and roster actors that are not safe path components (CWE-22 defense in depth)', () => {
    // phase id and persona names become filesystem path components downstream (prompts/work-{id}.md,
    // reviews/{iter}/{actor}.json). A repo-local .agent-loop.yaml override is already treated as
    // untrusted (its path is containment-checked), so the strings it yields must be charset-validated
    // too — a `../`-laden id/actor must be dropped at parse time, like any other malformed entry.
    const evil =
      'name: evil-loop\nschema_version: "4"\n' +
      'default_roster_id: r\n' +
      'rosters:\n  - id: r\n    ordered_actors: [review-principal, "../../../../etc/passwd", review-security]\n' +
      'phases:\n' +
      '  - id: plan\n    entry_status: plan-draft\n    roster_override_id: ""\n' +
      '  - id: "../../escape"\n    entry_status: x\n    roster_override_id: ""\n' +
      'gates:\n  - id: g\n    kind: terminal\n    human_options: []\n';
    writeFileSync(join(repo, 'evil.yaml'), evil);
    writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  evil-loop: ./evil.yaml\n');
    const def = parseLoopDef(repo, 'evil-loop');
    expect(def?.phases).toEqual([
      { id: 'plan', entryStatus: 'plan-draft', rosterOverrideId: '', postCleanGate: '', postNeedsWorkGate: '' },
    ]);
    expect(reviewerRosterForPhase(def!, 'plan')).toEqual(['review-principal', 'review-security']);
  });

  it('omits pickup when the LoopDef carries no pickup_contract (degrades, never throws)', () => {
    mkdirSync(join(repo, 'loops', 'impl-loop'), { recursive: true });
    writeFileSync(join(repo, 'loops', 'impl-loop', 'impl-loop.yaml'), IMPL_LOOP);
    // A repo configDir override would need its own .agent-loop.yaml; resolve via the example impl-loop,
    // which DOES carry a pickup_contract, so instead assert the minimal IMPL_LOOP fixture has none.
    writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  bare: ./bare.yaml\n');
    writeFileSync(join(repo, 'bare.yaml'), IMPL_LOOP);
    expect(parseLoopDef(repo, 'bare')?.pickup).toBeUndefined();
  });
});
