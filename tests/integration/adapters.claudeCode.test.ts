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

  // withFallback mirrors production (§15.3): the generic heuristic is always present,
  // so a chrome window claudeCode fails to claim is captured greedily by the fallback —
  // exactly the leak the chrome tests must pin.
  async function run(fixture: string, claudeEnabled = true, withFallback = false): Promise<ScannerEmission[]> {
    const emitted: ScannerEmission[] = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: claudeEnabled ? [createClaudeCodeAdapter()] : [],
      fallback: withFallback ? createGenericAdapter() : undefined,
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

  it('no longer emits a permission box as a semantic event (v2.6 removed permission detection)', async () => {
    const events = await run(PERMISSION_BOX);
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

  it('detects a ⏺ prose block as one report with per-list-item and per-paragraph findings', async () => {
    const events = await run(REPORT_BLOCK);
    const reports = events.filter((e) => e.type === 'report');
    expect(reports.length).toBe(1);
    expect(reports[0].source).toBe('shadow-scan');
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
    // Even with the greedy generic fallback present, the composer is structural chrome.
    const events = await run(INPUT_BOX, true, true);
    expect(events).toEqual([]);
  });

  it('captures a ⏺ report but not the composer chrome drawn below it (§15.x)', async () => {
    const events = await run(REPORT_BLOCK + INPUT_BOX);
    const reports = events.filter((e) => e.type === 'report');
    expect(reports.length).toBe(1);
    // The composer text must not bleed into the report body.
    expect(reports[0].text).not.toContain('eliminate the noise');
    expect(reports[0].text).not.toContain('auto mode on');
  });

  it('treats the spinner, slash-command echo, and composer all as chrome (§15.x)', async () => {
    const events = await run(SPINNER_STATUS + SLASH_ECHO + INPUT_BOX, true, true);
    expect(events).toEqual([]);
  });

  it('emits nothing when the adapter is disabled (§15.7 escape hatch)', async () => {
    const events = await run(REPORT_BLOCK, false);
    expect(events.length).toBe(0);
  });

  it('captures the whole report when it streams across two quiet scans and its ⏺ scrolls above the fold', async () => {
    // Small viewport so the report's ⏺ scrolls out before the tail arrives; the
    // second scan's window then opens below it (a headless continuation). The input
    // box redrawn at the bottom is the real-session chrome that keeps the adapter
    // selected on that scan — without it the bug hides behind the generic fallback.
    const emitted: Array<ScannerEmission & { id: string }> = [];
    const removed: string[] = [];
    shadow = createShadowModel({ cols: 80, rows: 6, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [createClaudeCodeAdapter()],
      dedupRetention: 200,
      reportMinChars: 120,
      emit: (e) => {
        const id = String(emitted.length + 1);
        emitted.push({ ...e, id });
        return id;
      },
      remove: (id) => removed.push(id),
    });

    // Phase 1: the agent prints the head + opening of a prose report, then pauses.
    shadow.write(
      '⏺ Here is the pull-request review the codebase scan surfaced this pass:\r\n' +
        '\r\n' +
        'The authentication flow is sound and the migration path is well covered.\r\n' +
        'The error handling around the network layer could be tightened up though.\r\n',
    );
    await goQuiet();

    // Phase 2: the agent resumes the same block (no new ⏺) — by now the bullet has
    // scrolled above the 6-row viewport — then redraws the input box below it.
    shadow.write(
      'The test suite gives good coverage of the new branches and edge cases here.\r\n' +
        'FINAL CONCLUSION: approve the pull request once the network nits are fixed.\r\n' +
        INPUT_BOX,
    );
    await goQuiet();

    // The complete report (with the tail that scrolled above the fold) is captured...
    const reports = emitted.filter((e) => e.type === 'report');
    const survivors = reports.filter((r) => !removed.includes(r.id));
    expect(survivors.length).toBe(1);
    expect(survivors[0].text).toContain('FINAL CONCLUSION: approve the pull request');
    // ...and the earlier partial (emitted before the tail arrived) is retracted, not
    // left behind as a duplicate (§15.3).
    const partial = reports.find((r) => !r.text.includes('FINAL CONCLUSION'));
    expect(partial).toBeDefined();
    expect(removed).toContain(partial!.id);
  });
});
