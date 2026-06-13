import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmission } from '../../src/main/scanner';
import { createClaudeCodeAdapter } from '../../src/main/adapters/claudeCode';
import { AGENT_QUESTION_BULLET, DIFF_BLOCK, INPUT_BOX, PERMISSION_BOX, REPORT_BLOCK, TOOL_USE } from '../fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goQuiet = () => sleep(220);

describe('Claude Code adapter (§15.3 / v2.6) — asserts on emitted events only', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  afterEach(() => shadow.dispose());

  async function run(fixture: string, claudeEnabled = true): Promise<ScannerEmission[]> {
    const emitted: ScannerEmission[] = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 10, quietMs: 40, onStatus: () => {} });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: claudeEnabled ? [createClaudeCodeAdapter()] : [],
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

  it('never emits the input box as content (it is chrome)', async () => {
    const events = await run(INPUT_BOX);
    expect(events.length).toBe(0);
  });

  it('emits nothing when the adapter is disabled (§15.7 escape hatch)', async () => {
    const events = await run(REPORT_BLOCK, false);
    expect(events.length).toBe(0);
  });
});
