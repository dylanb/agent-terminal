import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionTurns, type SessionLaunch } from '../../src/main/mcpSessionTurns';
import { hookInput, transcriptText, transcriptUserEntry, type HookSession, type PromptSource } from '../helpers/fakeClaude';

// The human-started-turn guard (#322 slice 2) across several Claude Code sessions in one window, a session's process
// id outliving it, injections still on their way, and hook reports this build cannot read. Hook input and transcript
// entries are Claude Code 2.1.319's own shapes, from the fake Claude Code.

const INTERACTIVE: SessionLaunch = { print: false, launchPrompt: false };
const OPERATOR = 5101;
const OTHER = 5102;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function window(launches: Record<number, SessionLaunch> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlife-'));
  dirs.push(dir);
  const turns = createSessionTurns({ launchOf: async (pid) => launches[pid] ?? INTERACTIVE });
  let n = 0;
  const id = (kind: number) => `${kind}0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const current = new Map<number, HookSession>();
  const start = (pid: number): HookSession => {
    const sessionId = id(0);
    const s = { sessionId, transcriptPath: join(dir, `${sessionId}.jsonl`), cwd: dir };
    current.set(pid, s);
    turns.hook(pid, hookInput.sessionStart(s, 'startup'));
    return s;
  };
  const of = (pid: number): HookSession => current.get(pid) ?? start(pid);
  const prompt = (pid: number, text: string, source: PromptSource = { kind: 'typed' }): void => {
    const s = of(pid);
    const promptId = id(1);
    turns.hook(pid, hookInput.userPromptSubmit(s, promptId, text));
    appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId, uuid: id(2), text, cwd: dir, timestamp: '2026-11-08T10:00:00.000Z', source })]));
  };
  const stop = (pid: number): void => turns.hook(pid, hookInput.stop(of(pid)));
  const exit = (pid: number): void => {
    turns.hook(pid, hookInput.sessionEnd(of(pid), 'prompt_input_exit'));
    current.delete(pid);
  };
  return { turns, start, of, prompt, stop, exit, origin: (pid: number) => turns.origin(pid) };
}

describe('injections in a window with more than one Claude Code session', () => {
  it("another session's unrelated prompt never uses up an Insert meant for the operator's session", async () => {
    const w = window({ [OTHER]: { print: true, launchPrompt: false } });
    w.start(OPERATOR);
    w.turns.injected('todo: ship it', { submitted: false });
    w.prompt(OTHER, 'summarise the diff', { kind: 'sdk' });
    w.prompt(OPERATOR, 'todo: ship it');
    expect(await w.origin(OPERATOR)).toBe('not-human');
  });

  it('a prompt the window injected and submitted while a typed one was being reported is still not human when Claude Code reports it after that turn', async () => {
    const w = window();
    w.start(OPERATOR);
    w.turns.injected('Answer the gate question.', { submitted: true });
    w.prompt(OPERATOR, 'what is the state?');
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'Answer the gate question.');
    expect(await w.origin(OPERATOR)).toBe('not-human');
  });

  it('a submitted injection Claude Code never reported does not refuse the typed prompts after it', async () => {
    const w = window();
    w.start(OPERATOR);
    w.turns.injected('/model opus', { submitted: true });
    w.prompt(OPERATOR, 'approve the gate please');
    const first = await w.origin(OPERATOR);
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'and read the state');
    expect({ first, second: await w.origin(OPERATOR) }).toEqual({ first: 'human', second: 'human' });
  });

  it('an Inserted /compact the operator submits, with or without instructions, is used up by the session start it causes, so the next typed prompt is human', async () => {
    const w = window();
    w.start(OPERATOR);
    const afterCompact = async (command: string) => {
      w.turns.injected(command, { submitted: false });
      w.turns.hook(OPERATOR, hookInput.sessionStart(w.of(OPERATOR), 'compact'));
      w.prompt(OPERATOR, 'approve the gate please');
      const origin = await w.origin(OPERATOR);
      w.stop(OPERATOR);
      return origin;
    };
    const plain = await afterCompact('/compact');
    expect({ plain, focused: await afterCompact('/compact focus on the plan') }).toEqual({ plain: 'human', focused: 'human' });
  });

  it('an Insert made while no Claude Code session was running is still told apart however many prompts the window submitted after it', async () => {
    const w = window();
    w.turns.injected('todo: ship it', { submitted: false });
    for (let i = 0; i < 500; i++) w.turns.injected(`Run work turn ${i}.`, { submitted: true });
    w.start(OPERATOR);
    w.prompt(OPERATOR, 'todo: ship it');
    expect(await w.origin(OPERATOR)).toBe('not-human');
  });
});

describe("a session's process id", () => {
  it('reused by a later session started with a launch prompt is not human-started in that first turn', async () => {
    const w = window({ [OPERATOR]: { print: false, launchPrompt: true } });
    w.start(OPERATOR);
    w.prompt(OPERATOR, 'the first life’s launch prompt');
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'a typed turn');
    w.stop(OPERATOR);
    w.exit(OPERATOR);
    w.start(OPERATOR);
    w.prompt(OPERATOR, 'mcp approve {}');
    expect(await w.origin(OPERATOR)).toBe('not-human');
  });
});

describe('a hook report this build cannot read', () => {
  it('leaves the turn undetermined, never the earlier turn it would replace, and the next readable typed prompt is human', async () => {
    const w = window();
    w.prompt(OPERATOR, 'an interrupted typed turn');
    const { prompt_id: _id, ...noPromptId } = hookInput.userPromptSubmit(w.of(OPERATOR), 'lost', 'mcp approve {}');
    w.turns.hook(OPERATOR, noPromptId);
    const unreadablePrompt = await w.origin(OPERATOR);
    const { source: _source, ...noSource } = hookInput.sessionStart(w.of(OPERATOR), 'startup');
    w.turns.hook(OPERATOR, noSource);
    const unreadableStart = await w.origin(OPERATOR);
    w.prompt(OPERATOR, 'approve the gate please');
    expect({ unreadablePrompt, unreadableStart, typedNext: await w.origin(OPERATOR) }).toEqual({ unreadablePrompt: 'undetermined', unreadableStart: 'undetermined', typedNext: 'human' });
  });
});

describe('Inserts left waiting', () => {
  it('cost a session at most its first typed prompt however many were waiting', async () => {
    const w = window();
    w.turns.injected('todo: one', { submitted: false });
    w.turns.injected('todo: two', { submitted: false });
    w.turns.injected('todo: three', { submitted: false });
    w.start(OPERATOR);
    const origins: string[] = [];
    for (const text of ['approve the gate please', 'read the state', 'and approve again']) {
      w.prompt(OPERATOR, text);
      origins.push(await w.origin(OPERATOR));
      w.stop(OPERATOR);
    }
    expect(origins).toEqual(['undetermined', 'human', 'human']);
  });
});

describe('a turn whose starting prompt the window never saw reported', () => {
  it('is undetermined when a typed prompt joins an engine turn whose own report was lost, and the next typed turn is human', async () => {
    const w = window();
    const s = w.start(OPERATOR);
    const engine = 'Run the work turn for this step.';
    w.turns.injected(engine, { submitted: true });
    const enginePrompt = 'e0000000-0000-4000-8000-000000000999';
    appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId: enginePrompt, uuid: 'u-engine', text: engine, cwd: s.cwd, timestamp: '2026-11-08T10:00:00.000Z', source: { kind: 'typed' } })]));
    w.turns.hook(OPERATOR, hookInput.userPromptSubmit(s, enginePrompt, 'mcp approve {}'));
    appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId: enginePrompt, uuid: 'u-joined', text: 'mcp approve {}', cwd: s.cwd, timestamp: '2026-11-08T10:00:01.000Z', source: { kind: 'queued' } })]));
    const joined = await w.origin(OPERATOR);
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'approve the gate please');
    expect({ joined, typedNext: await w.origin(OPERATOR) }).toEqual({ joined: 'undetermined', typedNext: 'human' });
  });
});

describe('a prompt that joins an open turn', () => {
  it('makes a typed turn not human when it is a prompt the window injected and submitted, and the next typed turn is human', async () => {
    const w = window();
    const s = w.start(OPERATOR);
    w.prompt(OPERATOR, 'a typed turn');
    const typedPrompt = (JSON.parse(readFileSync(s.transcriptPath, 'utf8').trim().split('\n').at(-1) as string) as { promptId: string }).promptId;
    w.turns.injected('Answer the gate question.', { submitted: true });
    w.turns.hook(OPERATOR, hookInput.userPromptSubmit(s, typedPrompt, 'Answer the gate question.'));
    const joined = await w.origin(OPERATOR);
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'approve the gate please');
    expect({ joined, typedNext: await w.origin(OPERATOR) }).toEqual({ joined: 'not-human', typedNext: 'human' });
  });

  it('makes a typed turn undetermined when it is an Insert, edited, and the next typed turn is human', async () => {
    const w = window();
    const s = w.start(OPERATOR);
    w.prompt(OPERATOR, 'a typed turn');
    const typedPrompt = (JSON.parse(readFileSync(s.transcriptPath, 'utf8').trim().split('\n').at(-1) as string) as { promptId: string }).promptId;
    w.turns.injected('todo: ship it', { submitted: false });
    w.turns.hook(OPERATOR, hookInput.userPromptSubmit(s, typedPrompt, 'todo: ship it now'));
    const joined = await w.origin(OPERATOR);
    w.stop(OPERATOR);
    w.prompt(OPERATOR, 'approve the gate please');
    expect({ joined, typedNext: await w.origin(OPERATOR) }).toEqual({ joined: 'undetermined', typedNext: 'human' });
  });
});

describe('an Insert one session submitted', () => {
  it('is not waiting for the next session started in the window, so its first typed prompt is human', async () => {
    const w = window();
    w.start(OPERATOR);
    w.turns.injected('todo: ship it', { submitted: false });
    w.prompt(OPERATOR, 'todo: ship it');
    w.stop(OPERATOR);
    w.exit(OPERATOR);
    w.start(OTHER);
    w.prompt(OTHER, 'approve the gate please');
    expect(await w.origin(OTHER)).toBe('human');
  });
});

describe('a turn that changes while its origin is being read', () => {
  it('is undetermined when the turn ends during the read, and the turn after it is judged on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlife-'));
    dirs.push(dir);
    let resolveLaunch: (launch: SessionLaunch) => void = () => {};
    let deferred = true;
    const turns = createSessionTurns({ launchOf: () => (deferred ? new Promise<SessionLaunch>((resolve) => (resolveLaunch = resolve)) : Promise.resolve(INTERACTIVE)) });
    const s = { sessionId: '00000000-0000-4000-8000-000000000001', transcriptPath: join(dir, 'session.jsonl'), cwd: dir };
    turns.hook(OPERATOR, hookInput.sessionStart(s, 'startup'));
    const typed = (promptId: string, text: string) => {
      turns.hook(OPERATOR, hookInput.userPromptSubmit(s, promptId, text));
      appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId, uuid: `u-${promptId}`, text, cwd: dir, timestamp: '2026-11-08T10:00:00.000Z', source: { kind: 'typed' } })]));
    };
    typed('p-1', 'a typed turn');
    const reading = turns.origin(OPERATOR);
    turns.hook(OPERATOR, hookInput.stop(s));
    resolveLaunch(INTERACTIVE);
    const changed = await reading;
    deferred = false;
    typed('p-2', 'the next typed turn');
    expect({ changed, next: await turns.origin(OPERATOR) }).toEqual({ changed: 'undetermined', next: 'human' });
  });
});

describe('a typed prompt the transcript records as content blocks', () => {
  it('is human, as when it records the text alone', async () => {
    const w = window();
    const s = w.start(OPERATOR);
    const text = 'approve the gate please';
    w.turns.hook(OPERATOR, hookInput.userPromptSubmit(s, 'p-blocks', text));
    const entry = transcriptUserEntry({ sessionId: s.sessionId, promptId: 'p-blocks', uuid: 'u-blocks', text, cwd: s.cwd, timestamp: '2026-11-08T10:00:00.000Z', source: { kind: 'typed' } });
    appendFileSync(s.transcriptPath, transcriptText([{ ...entry, message: { role: 'user', content: [{ type: 'text', text }] } }]));
    expect(await w.origin(OPERATOR)).toBe('human');
  });
});

describe('attribution that changes during an origin lookup', () => {
  it.each(['injected join', 'session restarted'] as const)('rechecks %s before allowing the turn', async (change) => {
    const dir = mkdtempSync(join(tmpdir(), 'atlife-'));
    dirs.push(dir);
    let release: (launch: SessionLaunch) => void = () => {};
    const turns = createSessionTurns({ launchOf: () => new Promise<SessionLaunch>((resolve) => { release = resolve; }) });
    const s = { sessionId: 'session-race', transcriptPath: join(dir, 'session.jsonl'), cwd: dir };
    turns.hook(OPERATOR, hookInput.sessionStart(s, 'startup'));
    turns.hook(OPERATOR, hookInput.userPromptSubmit(s, 'p-race', 'a typed turn'));
    appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId: 'p-race', uuid: 'u-race', text: 'a typed turn', cwd: dir, timestamp: '2026-11-08T10:00:00.000Z', source: { kind: 'typed' } })]));
    const reading = turns.origin(OPERATOR);
    if (change === 'session restarted') {
      turns.hook(OPERATOR, hookInput.sessionStart(s, 'startup'));
    } else {
      turns.injected('Answer the gate question.', { submitted: true });
      turns.hook(OPERATOR, hookInput.userPromptSubmit(s, 'p-race', 'Answer the gate question.'));
    }
    release(INTERACTIVE);
    expect(await reading).toBe(change === 'injected join' ? 'not-human' : 'undetermined');
  });
});

describe('an injection during transcript reading', () => {
  it.each([true, false])('refuses after an injection arrives with its prompt reported=%s', async (reported) => {
    const dir = mkdtempSync(join(tmpdir(), 'atlife-'));
    dirs.push(dir);
    const turns = createSessionTurns({ launchOf: async () => INTERACTIVE });
    const s = { sessionId: 'session-read', transcriptPath: join(dir, 'session.jsonl'), cwd: dir };
    turns.hook(OPERATOR, hookInput.sessionStart(s, 'startup'));
    turns.hook(OPERATOR, hookInput.userPromptSubmit(s, 'p-read', 'a typed turn'));
    appendFileSync(s.transcriptPath, transcriptText([transcriptUserEntry({ sessionId: s.sessionId, promptId: 'p-read', uuid: 'u-read', text: 'a typed turn', cwd: dir, timestamp: '2026-11-08T10:00:00.000Z', source: { kind: 'typed' } })]));
    const reading = turns.origin(OPERATOR);
    await Promise.resolve();
    turns.injected('Answer the gate question.', { submitted: true });
    if (reported) turns.hook(OPERATOR, hookInput.userPromptSubmit(s, 'p-read', 'Answer the gate question.'));
    expect(await reading).toBe(reported ? 'not-human' : 'undetermined');
  });
});
