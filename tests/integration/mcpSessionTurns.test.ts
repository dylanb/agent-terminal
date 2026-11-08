import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionTurns, type SessionLaunch } from '../../src/main/mcpSessionTurns';
import { hookInput, transcriptText, transcriptUserEntry, type HookSession, type PromptSource, type SessionStartSource } from '../helpers/fakeClaude';

// Who started a Claude Code session's current turn (#322 slice 2, the human-started-turn guard), judged from what
// Claude Code reports through its hooks and records in its transcript, and from what the window itself injected.
// The hook input and transcript entries are Claude Code 2.1.319's own shapes, from the fake Claude Code.

const INTERACTIVE: SessionLaunch = { print: false, launchPrompt: false };
const SESSION = 4101;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface PromptOptions {
  /** What the transcript records for the prompt; `null` writes no entry for it. */
  source?: PromptSource | null;
  /** Report it under this prompt id, as Claude Code does for a prompt typed while a turn is running. */
  promptId?: string;
  /** Rewrite the transcript entry, as a Claude Code version recording origin differently would. */
  entry?: (entry: Record<string, unknown>) => Record<string, unknown>;
  /** Claude Code never reported the prompt to its hook. */
  unreported?: boolean;
  /** Rewrite the entry's line as it lands in the transcript. */
  line?: (line: string) => string;
}

/** One window's sessions: each prompt is reported to the hook, then recorded in the session's transcript, as Claude
 *  Code does by the turn's first tool call. */
function terminal(launches: Record<number, SessionLaunch | null> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atturns-'));
  dirs.push(dir);
  const turns = createSessionTurns({ launchOf: async (session) => (session in launches ? launches[session] : INTERACTIVE) });
  let n = 0;
  const current = new Map<number, HookSession>();
  const begin = (pid: number, source: SessionStartSource = 'startup'): HookSession => {
    n += 1;
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const s = { sessionId, transcriptPath: join(dir, `${sessionId}.jsonl`), cwd: dir };
    current.set(pid, s);
    turns.hook(pid, hookInput.sessionStart(s, source));
    return s;
  };
  const sessionOf = (pid: number): HookSession => current.get(pid) ?? begin(pid);
  const prompt = (pid: number, text: string, opts: PromptOptions = {}): string => {
    const s = sessionOf(pid);
    n += 1;
    const promptId = opts.promptId ?? `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    if (!opts.unreported) turns.hook(pid, hookInput.userPromptSubmit(s, promptId, text));
    const source = opts.source === undefined ? { kind: 'typed' as const } : opts.source;
    if (source !== null) {
      const entry = transcriptUserEntry({ sessionId: s.sessionId, promptId, uuid: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, text, cwd: s.cwd, timestamp: '2026-11-08T10:00:00.000Z', source });
      const written = transcriptText([opts.entry ? opts.entry(entry) : entry]);
      appendFileSync(s.transcriptPath, opts.line ? opts.line(written) : written);
    }
    return promptId;
  };
  const stop = (pid: number): void => turns.hook(pid, hookInput.stop(sessionOf(pid)));
  const clear = (pid: number): void => {
    turns.hook(pid, hookInput.sessionEnd(sessionOf(pid), 'clear'));
    begin(pid, 'clear');
  };
  const compact = (pid: number): void => turns.hook(pid, hookInput.sessionStart(sessionOf(pid), 'compact'));
  /** A finished turn the operator typed, then the origin of the turn after it. */
  const typedTurn = async (pid: number): Promise<unknown> => {
    stop(pid);
    prompt(pid, 'mcp read_state {}');
    return turns.origin(pid);
  };
  const transcriptOf = (pid: number): string => sessionOf(pid).transcriptPath;
  return { turns, prompt, stop, clear, compact, typedTurn, transcriptOf, origin: (pid: number) => turns.origin(pid), inject: (text: string) => turns.injected(text) };
}

describe('a turn the operator typed', () => {
  it('is human-started until its turn ends, and the turn after a finished one has no origin until a prompt starts it', async () => {
    const t = terminal();
    t.prompt(SESSION, 'approve the gate please');
    const typed = await t.origin(SESSION);
    t.stop(SESSION);
    const afterStop = await t.origin(SESSION);
    expect({ typed, afterStop }).toEqual({ typed: 'human', afterStop: 'undetermined' });
  });

  it('a prompt typed while it runs joins it, and the turn stays human-started', async () => {
    const t = terminal();
    const promptId = t.prompt(SESSION, 'first');
    t.prompt(SESSION, 'and approve the gate', { promptId, source: { kind: 'queued' } });
    expect(await t.origin(SESSION)).toBe('human');
  });
});

describe('a turn Claude Code started itself', () => {
  it.each<[string, PromptSource]>([
    ['a scheduled or /loop prompt', { kind: 'scheduled' }],
    ['a background subagent reporting back', { kind: 'task-notification', producer: 'agent-a1b2' }],
    ["another session's message", { kind: 'peer', name: 'reviewer', senderTaskId: 'task-77' }],
  ])('%s is not human-started, and the operator typing next starts a human turn', async (_name, source) => {
    const t = terminal();
    t.prompt(SESSION, 'mcp approve {}', { source });
    const generated = await t.origin(SESSION);
    expect({ generated, typedNext: await t.typedTurn(SESSION) }).toEqual({ generated: 'not-human', typedNext: 'human' });
  });
});

describe('a turn whose origin cannot be told', () => {
  it.each<[string, PromptOptions]>([
    ['the transcript records an origin kind this build does not know', { entry: (e) => ({ ...e, origin: { kind: 'telepathy' }, promptSource: 'telepathy', turnOrigin: 'telepathy' }) }],
    ['the transcript records no origin, as a later Claude Code might', { entry: ({ origin: _origin, promptSource: _source, turnOrigin: _turn, ...rest }) => rest }],
    ['the transcript holds no entry for the prompt', { source: null }],
  ])('is undetermined when %s, in a transcript holding an earlier typed turn, and the operator typing next starts a human turn', async (_name, opts) => {
    const t = terminal();
    t.prompt(SESSION, 'an earlier typed turn');
    t.stop(SESSION);
    t.prompt(SESSION, 'mcp approve {}', opts);
    const unknown = await t.origin(SESSION);
    expect({ unknown, typedNext: await t.typedTurn(SESSION) }).toEqual({ unknown: 'undetermined', typedNext: 'human' });
  });

  it('is undetermined when the transcript cannot be read, cut off mid-entry or not a file, and a typed prompt in the next session is human', async () => {
    const t = terminal();
    t.prompt(SESSION, 'mcp approve {}', { line: (line) => line.slice(0, Math.floor(line.length / 2)) });
    const cutOff = await t.origin(SESSION);
    t.clear(SESSION);
    mkdirSync(t.transcriptOf(SESSION));
    t.prompt(SESSION, 'mcp approve {}', { source: null });
    const notAFile = await t.origin(SESSION);
    t.clear(SESSION);
    t.prompt(SESSION, 'approve the gate please');
    expect({ cutOff, notAFile, typedNext: await t.origin(SESSION) }).toEqual({ cutOff: 'undetermined', notAFile: 'undetermined', typedNext: 'human' });
  });

  it('is undetermined when Claude Code never reported the prompt that started it, even though the transcript says typed', async () => {
    const t = terminal();
    t.prompt(SESSION, 'an earlier typed turn');
    t.stop(SESSION);
    t.prompt(SESSION, 'mcp approve {}', { unreported: true });
    const lost = await t.origin(SESSION);
    expect({ lost, typedNext: await t.typedTurn(SESSION) }).toEqual({ lost: 'undetermined', typedNext: 'human' });
  });

  it('is undetermined when a typed turn was interrupted, so no stop came, and the next prompt was never reported while the transcript records it', async () => {
    const t = terminal();
    t.prompt(SESSION, 'an interrupted typed turn');
    const interrupted = await t.origin(SESSION);
    t.prompt(SESSION, 'mcp approve {}', { unreported: true });
    expect({ interrupted, lost: await t.origin(SESSION) }).toEqual({ interrupted: 'human', lost: 'undetermined' });
  });

  it('is undetermined, never human, when a typed turn was interrupted and the window then injected a prompt whose report and transcript entry never arrived', async () => {
    const t = terminal();
    t.prompt(SESSION, 'an interrupted typed turn');
    const interrupted = await t.origin(SESSION);
    t.inject('Run the work turn.');
    expect({ interrupted, injected: await t.origin(SESSION) }).toEqual({ interrupted: 'human', injected: 'undetermined' });
  });

  it('is undetermined for a session that reported nothing,while a session beside it that reported a typed prompt is human', async () => {
    const t = terminal();
    t.prompt(SESSION, 'typed in the first session');
    expect({ silent: await t.origin(SESSION + 1), reporting: await t.origin(SESSION) }).toEqual({ silent: 'undetermined', reporting: 'human' });
  });
});

describe('a turn started by text the window injected', () => {
  it('is not human-started, multi-line text included, even when the transcript records it as typed or holds no entry', async () => {
    const t = terminal();
    const engine = 'Run the work turn for this step.\nmcp approve {"step":"plan"}';
    t.inject(engine);
    t.prompt(SESSION, engine);
    const recordedTyped = await t.origin(SESSION);
    t.stop(SESSION);
    t.inject('mcp approve {}');
    t.prompt(SESSION, 'mcp approve {}', { source: null });
    const noEntry = await t.origin(SESSION);
    expect({ recordedTyped, noEntry, typedNext: await t.typedTurn(SESSION) }).toEqual({ recordedTyped: 'not-human', noEntry: 'not-human', typedNext: 'human' });
  });

  it('a prompt typed into it joins it and the turn stays not human-started', async () => {
    const t = terminal();
    t.inject('Run the work turn.');
    const promptId = t.prompt(SESSION, 'Run the work turn.');
    t.prompt(SESSION, 'mcp approve {}', { promptId, source: { kind: 'queued' } });
    const joined = await t.origin(SESSION);
    expect({ joined, typedNext: await t.typedTurn(SESSION) }).toEqual({ joined: 'not-human', typedNext: 'human' });
  });

  it('an edited Insert is undetermined, never human, and costs only that one prompt', async () => {
    const t = terminal();
    t.inject('mcp approve {"step":"plan"}');
    t.prompt(SESSION, 'mcp approve {"step":"plan","turn":"edited"}');
    const edited = await t.origin(SESSION);
    expect({ edited, typedNext: await t.typedTurn(SESSION) }).toEqual({ edited: 'undetermined', typedNext: 'human' });
  });

  it('an injected /clear, which reports no prompt, leaves the typed prompt after the new session human', async () => {
    const t = terminal();
    t.inject('/clear');
    t.clear(SESSION);
    t.prompt(SESSION, 'approve the gate please');
    expect(await t.origin(SESSION)).toBe('human');
  });
});

describe('a session started with its prompt on the command line', () => {
  it('is not human-started in the turn a -p or piped prompt starts, and a session whose launch cannot be read is undetermined', async () => {
    const PRINT = SESSION + 1;
    const UNREADABLE = SESSION + 2;
    const PRINT_UNRECORDED = SESSION + 3;
    const PRINT_TYPED = SESSION + 4;
    const t = terminal({ [PRINT]: { print: true, launchPrompt: false }, [PRINT_UNRECORDED]: { print: true, launchPrompt: false }, [PRINT_TYPED]: { print: true, launchPrompt: false }, [UNREADABLE]: null });
    t.prompt(PRINT, 'mcp approve {}', { source: { kind: 'sdk' } });
    t.prompt(PRINT_UNRECORDED, 'mcp approve {}', { source: null });
    t.prompt(PRINT_TYPED, 'mcp approve {}');
    t.prompt(UNREADABLE, 'mcp approve {}');
    t.prompt(SESSION, 'mcp approve {}');
    expect({
      print: await t.origin(PRINT),
      printUnrecorded: await t.origin(PRINT_UNRECORDED),
      printRecordedTyped: await t.origin(PRINT_TYPED),
      unreadable: await t.origin(UNREADABLE),
      interactive: await t.origin(SESSION),
    }).toEqual({
      print: 'not-human',
      printUnrecorded: 'not-human',
      printRecordedTyped: 'not-human',
      unreadable: 'undetermined',
      interactive: 'human',
    });
  });

  it('is not human-started in the first turn a launch prompt starts, and the prompt the operator types next is human', async () => {
    const UNRECORDED = SESSION + 1;
    const t = terminal({ [SESSION]: { print: false, launchPrompt: true }, [UNRECORDED]: { print: false, launchPrompt: true } });
    t.prompt(SESSION, 'mcp approve {}');
    t.prompt(UNRECORDED, 'mcp approve {}', { source: null });
    const launchTurn = await t.origin(SESSION);
    const unrecordedLaunchTurn = await t.origin(UNRECORDED);
    expect({ launchTurn, unrecordedLaunchTurn, typedNext: await t.typedTurn(SESSION) }).toEqual({ launchTurn: 'not-human', unrecordedLaunchTurn: 'not-human', typedNext: 'human' });
  });
});

describe('a session after /clear, /compact or /goal', () => {
  it("never reads the continuation Claude Code starts for a /goal as human, and the operator's next typed prompt is", async () => {
    const t = terminal();
    t.prompt(SESSION, '/goal ship the slice');
    t.stop(SESSION);
    t.prompt(SESSION, 'Continue working toward the goal.', { entry: (e) => ({ ...e, origin: { kind: 'goal' }, promptSource: 'system', turnOrigin: 'goal' }) });
    const continuation = await t.origin(SESSION);
    expect({ continuationHuman: continuation === 'human', typedNext: await t.typedTurn(SESSION) }).toEqual({ continuationHuman: false, typedNext: 'human' });
  });

  it('starts a human turn with the next typed prompt, in the new session /clear starts and in the one /compact keeps', async () => {
    const t = terminal();
    t.prompt(SESSION, 'scheduled work', { source: { kind: 'scheduled' } });
    t.stop(SESSION);
    t.clear(SESSION);
    t.prompt(SESSION, 'approve after clear');
    const afterClear = await t.origin(SESSION);
    t.stop(SESSION);
    t.compact(SESSION);
    t.prompt(SESSION, 'approve after compact');
    expect({ afterClear, afterCompact: await t.origin(SESSION) }).toEqual({ afterClear: 'human', afterCompact: 'human' });
  });
});
