import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmission } from '../../src/main/scanner';
import { createClaudeCodeAdapter } from '../../src/main/adapters/claudeCode';
import {
  AGENT_QUESTION_BULLET,
  DIFF_BLOCK,
  INPUT_BOX,
  PERMISSION_BOX,
  TOOL_USE,
} from '../fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goQuiet = () => sleep(220);

describe('Claude Code adapter (§15.3 / D5) — asserts on emitted events only', () => {
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
      emit: (e) => emitted.push(e),
    });
    shadow.write(fixture);
    await goQuiet();
    return emitted;
  }

  it('detects a permission box as exactly one permission-prompt containing the box text', async () => {
    const events = await run(PERMISSION_BOX);
    const perms = events.filter((e) => e.type === 'permission-prompt');
    expect(perms.length).toBe(1);
    expect(perms[0].text).toContain('Do you want to proceed?');
    expect(perms[0].text).toContain('1. Yes');
    expect(perms[0].source).toBe('shadow-scan');
  });

  it('detects a ⏺/⎿ block as tool-use', async () => {
    const events = await run(TOOL_USE);
    expect(events.filter((e) => e.type === 'tool-use').length).toBe(1);
  });

  it('detects a ⏺ line ending in ? as an agent-question', async () => {
    const events = await run(AGENT_QUESTION_BULLET);
    const qs = events.filter((e) => e.type === 'agent-question');
    expect(qs.length).toBe(1);
    expect(qs[0].text).toContain('Should I continue with the migration?');
  });

  it('detects ± lines inside a tool block as a diff', async () => {
    const events = await run(DIFF_BLOCK);
    expect(events.filter((e) => e.type === 'diff').length).toBe(1);
  });

  it('never emits the input box as content (it is chrome)', async () => {
    const events = await run(INPUT_BOX);
    expect(events.length).toBe(0);
  });

  it('emits nothing when the adapter is disabled (§15.7 escape hatch)', async () => {
    const events = await run(PERMISSION_BOX, false);
    expect(events.length).toBe(0);
  });
});
