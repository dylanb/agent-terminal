import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createCommandTracker, type CommandTracker } from '../../src/main/commandTracker';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import { createBootstrapCommandTracker } from '../../src/main/bootstrapCommands';

// Drive the REAL OSC-133 parser with scripted bytes (CLAUDE.md: no mocking the shadow / VT parser) so
// the correlation is proven through the same path bash drives, without a live PTY (§25.5).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const osc = (s: string) => `\x1b]${s}\x07`;
function runCmd(command: string, output: string, exit: number, prompt = '$ '): string {
  return osc('133;A') + prompt + osc('133;B') + command + '\r\n' + osc('133;C') + output + osc(`133;D;${exit}`);
}

describe('bootstrap command correlation over the real shadow + command tracker (§25.5)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let tracker: CommandTracker;
  let recorded: { repoKey: string; cmd: string; exit: number | null }[];

  function setup() {
    shadow = createShadowModel({ cols: 80, rows: 24, scrollback: 5000, settleMs: 5, quietMs: 20, onStatus: () => {} });
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: resolveRuntimeConfig({}),
    });
    recorded = [];
    return createBootstrapCommandTracker({
      summaries: () => tracker.summaries(),
      onChange: (cb) => tracker.onChange(cb),
      recordCommand: (repoKey, cmd, exit) => recorded.push({ repoKey, cmd, exit }),
    });
  }

  afterEach(() => {
    tracker.dispose();
    shadow.dispose();
  });

  it('records a noted bootstrap command with the exit code of its OSC-133 span', async () => {
    const bc = setup();
    bc.notePending('/repo', 'agent-loop pickup 176');
    shadow.write(runCmd('agent-loop pickup 176', 'bash: agent-loop: command not found\r\n', 127));
    await sleep(60);
    expect(recorded).toEqual([{ repoKey: '/repo', cmd: 'agent-loop pickup 176', exit: 127 }]);
  });

  it('records nothing for a command that is not the pending bootstrap', async () => {
    const bc = setup();
    bc.notePending('/repo', 'agent-loop pickup 176');
    shadow.write(runCmd('ls -la', 'a b c\r\n', 0));
    await sleep(60);
    expect(recorded).toEqual([]);
  });

  it('records the bootstrap exactly once across the span’s start and finish change events', async () => {
    const bc = setup();
    bc.notePending('/repo', 'agent-loop pickup 176');
    shadow.write(runCmd('agent-loop pickup 176', 'ok\r\n', 0));
    await sleep(60);
    expect(recorded).toHaveLength(1);
  });
});
