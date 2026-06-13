import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createScanner, type ScannerEmission } from '../../src/main/scanner';
import { createCommandTracker, type CommandTracker } from '../../src/main/commandTracker';
import { createClaudeCodeAdapter } from '../../src/main/adapters/claudeCode';
import { createGenericAdapter } from '../../src/main/adapters/generic';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import { ALT_BORING, BORING_NO_MARKS, BORING_WITH_MARKS, SPOOFED_OSC } from '../fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goQuiet = () => sleep(220);

const SEMANTIC = new Set(['agent-question', 'permission-prompt', 'tool-use', 'diff', 'completion']);

describe('false-positive budget (§15.8) — boring transcripts emit zero agent-semantic events', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let tracker: CommandTracker;
  afterEach(() => {
    tracker.dispose();
    shadow.dispose();
  });

  async function run(fixture: string): Promise<{ semantic: ScannerEmission[]; tracker: CommandTracker }> {
    const emitted: ScannerEmission[] = [];
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 10, quietMs: 40, onStatus: () => {} });
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: resolveRuntimeConfig({}),
    });
    createScanner({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onQuiet: (cb) => shadow.onQuiet(cb),
      adapters: [createClaudeCodeAdapter()],
      fallback: createGenericAdapter(),
      dedupRetention: 200,
      emit: (e) => emitted.push(e),
      closedSpans: () => tracker.closedSpans(),
    });
    shadow.write(fixture);
    await goQuiet();
    return { semantic: emitted.filter((e) => SEMANTIC.has(e.type)), tracker };
  }

  it('plain marked + unmarked commands (incl. a ❯ prompt) → zero semantic, command entries present', async () => {
    const { semantic, tracker } = await run(BORING_WITH_MARKS + BORING_NO_MARKS);
    expect(semantic).toEqual([]);
    expect(tracker.summaries().length).toBeGreaterThanOrEqual(2);
  });

  it('adversarial spoofed OSC-133 output fabricates no trusted agent-semantic events', async () => {
    const { semantic } = await run(SPOOFED_OSC);
    expect(semantic).toEqual([]);
  });

  it('alt-screen pager showing ordinary text with a "?" → zero semantic (conservative alt test)', async () => {
    const { semantic } = await run(ALT_BORING);
    expect(semantic).toEqual([]);
  });
});
