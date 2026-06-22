import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmission } from '../../src/main/scanner';
import { createClaudeCodeAdapter } from '../../src/main/adapters/claudeCode';
import { createGenericAdapter } from '../../src/main/adapters/generic';
import {
  AGENT_QUESTION_BULLET,
  DIFF_BLOCK,
  INPUT_BOX,
  PERMISSION_BOX,
  PERMISSION_PROMPT,
  REPORT_BLOCK,
  SLASH_ECHO,
  SPINNER_STATUS,
  TOOL_USE,
} from '../fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goQuiet = () => sleep(220);

describe('Claude Code adapter (§15.3 / v2.6) — asserts on emitted events only', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  afterEach(() => shadow.dispose());

  // §15.3: `claudeEnabled` toggles only the classifier; the glyph-agnostic baseline always runs.
  async function run(fixture: string, claudeEnabled = true): Promise<ScannerEmission[]> {
    const emitted: ScannerEmission[] = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: claudeEnabled ? [createClaudeCodeAdapter()] : [],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        emitted.push(e);
        return String(emitted.length);
      },
    });
    shadow.write(fixture);
    await goQuiet();
    return emitted;
  }

  it('captures corner-box content — a box is content, not chrome (Claude boxes real summaries, v2.17)', async () => {
    const events = await run(PERMISSION_BOX);
    expect(events.some((e) => e.type === 'report')).toBe(true);
  });

  it('never captures a full-width-rule-framed permission prompt — it is bottom chrome (§15.x)', async () => {
    const events = await run(PERMISSION_PROMPT);
    expect(events).toEqual([]);
  });

  it('detects a ⏺/⎿ block as tool-use', async () => {
    const events = await run(TOOL_USE);
    expect(events.filter((e) => e.type === 'tool-use').length).toBe(1);
  });

  it('detects ± lines inside a tool block as a diff', async () => {
    const events = await run(DIFF_BLOCK);
    expect(events.filter((e) => e.type === 'diff').length).toBe(1);
  });

  it('captures a ⏺ prose block as one report with per-list-item and per-paragraph findings', async () => {
    const events = await run(REPORT_BLOCK);
    const reports = events.filter((e) => e.type === 'report');
    expect(reports.length).toBe(1);
    expect(reports[0].source).toBe('heuristic'); // the glyph-agnostic baseline, not the ⏺ adapter
    expect(reports[0].parentId ?? null).toBeNull();
    expect(reports[0].text).toContain('summary of what the codebase review');
    expect(reports[0].text).toContain('principal');

    const findings = events.filter((e) => e.type === 'finding');
    // intro paragraph, two list items, closing paragraph
    expect(findings.length).toBe(4);
    expect(findings.every((f) => f.parentId !== null)).toBe(true);
    expect(findings.map((f) => f.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('summary of what the codebase review'),
        expect.stringContaining('principal'),
        expect.stringContaining('security'),
        expect.stringContaining('Overall the change looks solid'),
      ]),
    );
  });

  it('does not emit a short ⏺ prose line below the report threshold', async () => {
    const events = await run(AGENT_QUESTION_BULLET);
    expect(events).toEqual([]);
  });

  it('never emits the rule-bounded input composer as content (it is chrome, §15.x)', async () => {
    const events = await run(INPUT_BOX, true);
    expect(events).toEqual([]);
  });

  it('captures a ⏺ report but not the composer chrome drawn below it (§15.x)', async () => {
    const events = await run(REPORT_BLOCK + INPUT_BOX);
    const reports = events.filter((e) => e.type === 'report');
    expect(reports.length).toBe(1);
    expect(reports[0].text).not.toContain('eliminate the noise');
    expect(reports[0].text).not.toContain('auto mode on');
  });

  it('treats the spinner, slash-command echo, and composer all as chrome (§15.x)', async () => {
    const events = await run(SPINNER_STATUS + SLASH_ECHO + INPUT_BOX, true);
    expect(events).toEqual([]);
  });

  it('the Claude classifier toggle gates only enrichment — the baseline still captures (§15.7)', async () => {
    const reportEvents = await run(REPORT_BLOCK, false);
    expect(reportEvents.filter((e) => e.type === 'report').length).toBe(1);
    const toolEvents = await run(TOOL_USE, false);
    expect(toolEvents.filter((e) => e.type === 'tool-use').length).toBe(0);
  });

  it('REGRESSION: captures a review whose bullet glyph is ● (not ⏺) via the bullet-agnostic fallback', async () => {
    // Claude Code v2.1.177 rendered the assistant bullet as ● here, and the verdict
    // table's ┌ makes the Claude adapter claim the window via its box rule — yet it
    // recognizes no ⏺ report, so capture must fall through to the generic fallback.
    const RULE = '─'.repeat(78);
    const REVIEW =
      '● All 11 impl-loop reviewers have completed against PR #174. Here is the consolidated report.\r\n' +
      '\r\n' +
      '  Verdict summary\r\n' +
      '  ┌─────────────────┬──────────┬──────────┐\r\n' +
      '  │    Reviewer     │ Verdict  │ Findings │\r\n' +
      '  ├─────────────────┼──────────┼──────────┤\r\n' +
      '  │ intent          │ concerns │ 1 minor  │\r\n' +
      '  └─────────────────┴──────────┴──────────┘\r\n' +
      '\r\n' +
      '  No blockers. One major (diagrams). Everything else is minor across the eleven lanes here.\r\n' +
      '\r\n' +
      '  Want me to apply any of these fixes to the branch before we open it up for human review?\r\n' +
      '\r\n' +
      '✻ Churned for 4m 35s\r\n' +
      '\r\n' +
      RULE + '\r\n' +
      '❯\r\n' +
      RULE + '\r\n' +
      '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #174 · ← for agents\r\n';
    const events = await run(REVIEW, true);
    const captured = events.filter((e) => e.type === 'report' || e.type === 'finding');
    const text = captured.map((e) => e.text).join('\n');
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(text).toContain('All 11 impl-loop reviewers have completed');
    expect(text).toContain('Want me to apply any of these fixes');
    expect(text).not.toContain('auto mode on');
    expect(text).not.toContain('Churned for');
  });

  it('REGRESSION: captures a long ⏺ prose review sitting above the spinner + composer', async () => {
    const RULE = '─'.repeat(78);
    const REVIEW =
      "⏺ Here's the consolidated PR review across all lanes:\r\n" +
      '\r\n' +
      '  Blockers\r\n' +
      '\r\n' +
      '- The committed scripts/dev-seed.ts imports @pundits/mcp-server/dev-seed, so a clean\r\n' +
      "  checkout of HEAD can't resolve the module and dev-seed breaks. Stage and commit the\r\n" +
      '  barrel + the package.json export together.\r\n' +
      '\r\n' +
      '  Recurring minors (multiple lanes agreed)\r\n' +
      '\r\n' +
      '- Cross-root commit ordering: runDevSeedCli nests a memory-root tx inside the auth-root\r\n' +
      '  tx and commits memory first — reads atomic but is a best-effort two-phase write.\r\n' +
      '  - dev.sh fail-closed asymmetry: make dev-seed lacks the explicit exit 1 breadcrumb its\r\n' +
      '    migrate/zitadel siblings use. set -euo pipefail makes it fail-closed anyway.\r\n' +
      '\r\n' +
      '  Want me to action any of these — starting with committing the untracked dev-seed.ts?\r\n' +
      '\r\n' +
      '✻ Sautéed for 5m 22s\r\n' +
      '\r\n' +
      RULE + '\r\n' +
      '❯\r\n' +
      RULE + '\r\n' +
      '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #174 · ← for agents\r\n';
    const events = await run(REVIEW, true);
    const captured = events.filter((e) => e.type === 'report' || e.type === 'tool-use');
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const text = captured.map((e) => e.text).join('\n');
    expect(text).toContain('consolidated PR review');
    expect(text).toContain('Want me to action any of these');
    expect(text).not.toContain('auto mode on');
  });

  it('REGRESSION: captures a streamed ⏺ review whose head scrolls off, above a spinner + composer', async () => {
    const emitted: ScannerEmission[] = [];
    const removed: string[] = [];
    // Tiny viewport so the ⏺ head scrolls above the fold before the tail + chrome arrive.
    shadow = createShadowModel({ cols: 80, rows: 6, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [createClaudeCodeAdapter()],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        emitted.push(e);
        return String(emitted.length);
      },
      remove: (id) => removed.push(id),
    });

    // Phase 1: the ⏺ head + opening prints, then pauses.
    shadow.write(
      "⏺ Here's the consolidated PR review across all lanes. The committed dev-seed.ts barrel\r\n" +
        '  is untracked, so a clean checkout cannot resolve the module and dev-seed breaks here.\r\n',
    );
    await goQuiet();

    // Phase 2: the review resumes with no new ⏺ (the head has scrolled off), then chrome redraws below.
    const RULE = '─'.repeat(78);
    shadow.write(
      '- Cross-root commit ordering nests a memory-root tx inside the auth-root tx and commits\r\n' +
        '  - dev.sh fail-closed asymmetry: make dev-seed lacks the explicit exit 1 breadcrumb here\r\n' +
        '  Want me to action any of these — starting with committing the untracked dev-seed barrel?\r\n' +
        '\r\n' +
        '✻ Sautéed for 5m 22s\r\n' +
        '\r\n' +
        RULE + '\r\n' +
        '❯\r\n' +
        RULE + '\r\n' +
        '  ⏵⏵ auto mode on (shift+tab to cycle) · PR #174 · ← for agents\r\n',
    );
    await goQuiet();

    const captured = emitted.filter((e) => e.type === 'report' || e.type === 'tool-use');
    const survivors = captured.filter((e) => !removed.includes(String(emitted.indexOf(e) + 1)));
    const text = survivors.map((e) => e.text).join('\n');
    expect(text).toContain('Want me to action any of these');
    expect(text).not.toContain('auto mode on');
  });

  it('merges a report that streams across a quiet pause into one capture, retracting the partial (§15.3 seal-on-witness)', async () => {
    // Seal-on-witness (§15.3 / v2.22): a bottom-most unit with no witness below it (no following
    // content, no turn-complete composer) stays PROVISIONAL; when the tail grows the same position,
    // the partial is retracted and the fuller capture replaces it — one capture, not two.
    const emitted: Array<ScannerEmission & { id: string }> = [];
    const removed: string[] = [];
    shadow = createShadowModel({ cols: 80, rows: 6, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [createClaudeCodeAdapter()],
      baseline: createGenericAdapter(),
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        const id = String(emitted.length + 1);
        emitted.push({ ...e, id });
        return id;
      },
      remove: (id) => removed.push(id),
    });

    // Phase 1: the head + opening of a prose report prints, then pauses.
    shadow.write(
      '⏺ Here is the pull-request review the codebase scan surfaced this pass:\r\n' +
        '\r\n' +
        'The authentication flow is sound and the migration path is well covered.\r\n' +
        'The error handling around the network layer could be tightened up though.\r\n',
    );
    await goQuiet();

    // Phase 2: the same block resumes with no new ⏺ (the bullet has scrolled off), then the input box redraws below.
    shadow.write(
      'The test suite gives good coverage of the new branches and edge cases here.\r\n' +
        'FINAL CONCLUSION: approve the pull request once the network nits are fixed.\r\n' +
        INPUT_BOX,
    );
    await goQuiet();

    const reports = emitted.filter((e) => e.type === 'report');
    expect(removed).toContain('1'); // partial head retracted, not left as a duplicate (§15.3)
    const survivors = reports.filter((r) => !removed.includes(r.id));
    const merged = survivors.filter(
      (r) => r.text.includes('authentication flow is sound') && r.text.includes('FINAL CONCLUSION: approve the pull request'),
    );
    expect(merged).toHaveLength(1);
  });
});
