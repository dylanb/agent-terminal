import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../shared/audit';
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { stripPasteBreakout } from '../shared/paste';
import type { McpTmux } from '../shared/mcpBridge';
import type { TurnOrigin } from '../shared/turnOrigin';
import { errMsg, isErrno } from './errno';

/** How a Claude Code session was launched, as its command line shows: `print` for `-p`/`--print`, `launchPrompt` for
 *  a prompt given on the command line. */
export interface SessionLaunch {
  print: boolean;
  launchPrompt: boolean;
}

/** The turns of the Claude Code sessions in the window's terminal, each session named by its process id. */
export interface SessionTurns {
  /** A Claude Code hook's report: `input` is what Claude Code wrote to the hook's stdin. */
  hook(session: number, input: unknown, tmux?: McpTmux): void;
  /** Text main's injector wrote to the terminal; `submitted` when it also pressed Enter, rather than leaving the text
   *  for the operator to submit (an Insert). */
  injected(text: string, opts?: { submitted: boolean; sendingSession?: number }): void;
  origin(session: number): Promise<TurnOrigin>;
  prompt(session: number): Extract<AuditEvent, { type: 'mcp.prompt' }> | null;
  cancelPending(reason: string): void;
  cancelAuditDiscovery(): void;
  discoverHumanPrompts(): Promise<Extract<AuditEvent, { type: 'mcp.prompt' }>[]>;
  acceptSend(session: number, todo: { id: string; text: string }, persist?: () => void, delivered?: (reason?: string) => void): string | null;
  cancelInterruptedSends(): void;
  deliverPending(idle: boolean, inject: (text: string, session: number, recipient: string, tmux: McpTmux | undefined, delivery: { canReceive(): boolean; finish(reason?: string): void }) => void): void;
}

/** `injected`: the prompt matched text the window injected; `unmatched`: an Insert was waiting and the prompt
 *  matched nothing, so it may be that Insert edited. */
type PromptMatch = 'injected' | 'unmatched' | 'none';

interface Turn {
  auditLaunch?: SessionLaunch;
  auditMatch: PromptMatch;
  auditOrigin?: TurnOrigin;
  transcriptFailures?: Set<string>;
  auditVersion?: string;
  auditDiscovery?: Promise<void>;
  auditPrompt: Extract<AuditEvent, { type: 'mcp.prompt' }>;
  promptId: string;
  /** The prompt the report that started the turn carried, as `promptText` gives it. */
  prompt: string;
  /** Which of its session's turns this is, from 1. */
  ordinal: number;
  /** The injection count when it started, so an injection made during it is told apart. */
  injectionsAtStart: number;
  match: PromptMatch;
  sentTodoId?: string;
}

interface Session {
  tmux?: McpTmux;
  transcriptPath: string | null;
  /** `unknown` when Claude Code's latest report could not be read, so the turn it reported is not known. */
  turn: Turn | 'unknown' | null;
  turns: number;
  /** Whether Claude Code reported this process starting, so `turns` counts from its first turn. */
  started: boolean;
  /** The injections this session's prompts have used up. Each session keeps its own, so another session's prompt
   *  never uses up text meant for this one. */
  used: Set<number>;
  pending?: { id: string; text: string; turn: Turn; ready: boolean; recipient: string; delivering?: boolean; delivered?: (reason?: string) => void };
}

interface Injection {
  at: number;
  text: string;
  submitted: boolean;
}

type HookReport =
  | { event: 'SessionStart'; transcriptPath: string; source: string }
  | { event: 'SessionEnd'; transcriptPath: string; reason: string | null }
  | { event: 'Stop'; transcriptPath: string }
  | { event: 'UserPromptSubmit'; transcriptPath: string; promptId: string; prompt: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A hook's report, null when it is not one this build reads, or `ignored` for an event the guard does not use. */
function parseHookReport(input: unknown): HookReport | 'ignored' | null {
  if (!isRecord(input) || typeof input.hook_event_name !== 'string' || typeof input.transcript_path !== 'string') return null;
  const transcriptPath = input.transcript_path;
  switch (input.hook_event_name) {
    case 'SessionStart':
      return typeof input.source === 'string' ? { event: 'SessionStart', transcriptPath, source: input.source } : null;
    case 'SessionEnd':
      return { event: 'SessionEnd', transcriptPath, reason: typeof input.reason === 'string' ? input.reason : null };
    case 'Stop':
      return { event: 'Stop', transcriptPath };
    case 'UserPromptSubmit':
      return typeof input.prompt_id === 'string' && typeof input.prompt === 'string'
        ? { event: 'UserPromptSubmit', transcriptPath, promptId: input.prompt_id, prompt: input.prompt }
        : null;
    default:
      return 'ignored';
  }
}

/** Text as Claude Code reports a prompt: the paste markers the injector strips gone, line ends as `\n`, and no
 *  surrounding blank space. */
function promptText(text: string): string {
  return stripPasteBreakout(text).replace(/\r\n?/g, '\n').trim();
}

/** A user entry's prompt text, as `promptText` gives it: its content, or the text of its content blocks; null when it
 *  holds none. */
function entryText(entry: Record<string, unknown>): string | null {
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  if (typeof content === 'string') return promptText(content);
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []));
  return texts.length === 0 ? null : promptText(texts.join('\n'));
}

/** The origin kinds Claude Code records for prompts it started itself. */
const GENERATED_ORIGINS: ReadonlySet<string> = new Set(['scheduled', 'task-notification', 'peer']);

/** Who started the turn `promptId` names, as the transcript records it. A newer prompt than it means its turn is
 *  no longer the session's current one. */
function transcriptReader(promptId: string, prompt: string): { line(text: string): void; origin(scope: 'current' | 'historical'): TurnOrigin } {
  let first: Record<string, unknown> | undefined;
  let latest: string | undefined;
  return {
    line(text) {
      let entry: unknown;
      try { entry = JSON.parse(text); } catch { return; }
      if (!isRecord(entry) || entry.type !== 'user' || entry.isSidechain === true || typeof entry.promptId !== 'string') return;
      latest = entry.promptId;
      if (latest === promptId && !first) first = entry;
    },
    origin(scope) {
      if ((scope === 'current' && latest !== promptId) || !first || entryText(first) !== prompt) return 'undetermined';
      const kind = isRecord(first.origin) ? first.origin.kind : undefined;
      if (kind === 'human') return 'human';
      if (typeof kind === 'string' && GENERATED_ORIGINS.has(kind)) return 'not-human';
      if (kind === undefined && first.promptSource === 'sdk') return 'not-human';
      return 'undetermined';
    },
  };
}

const transcriptVersion = (value: Stats): string => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');

async function readTranscript(file: string, promptId: string, prompt: string, options: { unchangedVersion?: string; signal?: AbortSignal; scope?: 'current' | 'historical' } = {}): Promise<{ origin: TurnOrigin; version: string } | null> {
  const { unchangedVersion, signal, scope = 'current' } = options;
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    signal?.throwIfAborted();
    if (!info.isFile()) return null;
    const version = transcriptVersion(info);
    if (version === unchangedVersion) return null;
    if (info.size === 0) return { origin: 'undetermined', version };
    const reader = transcriptReader(promptId, prompt);
    const input = handle.createReadStream({ encoding: 'utf8', highWaterMark: 64 * 1024, end: info.size - 1, autoClose: false, signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of lines) {
        reader.line(line);
        if (++count % 64 === 0) await yieldImmediate();
      }
      return { origin: reader.origin(scope), version };
    } finally { lines.close(); input.destroy(); }
  } finally { await handle.close(); }
}

/** How many submitted injections no session has reported are kept. The oldest goes first: a submitted prompt is
 *  reported within its own turn, and an Insert, which only the operator submits, is never dropped. */
const MAX_WAITING_SUBMITTED = 64;

export function createSessionTurns(deps: { launchOf: (session: number) => Promise<SessionLaunch | null>; recipientOf?: (session: number, tmux?: McpTmux) => string | null }): SessionTurns {
  const sessions = new Map<number, Session>();
  const auditDiscovery = new AbortController();
  let injections: Injection[] = [];
  let count = 0;

  const fresh = (): Session => ({ transcriptPath: null, turn: null, turns: 0, started: false, used: new Set() });
  const pendingFor = (session: Session): Injection[] => injections.filter((injection) => !session.used.has(injection.at));
  /** An injection every session has used up can never be matched again; while no session is known, a session yet to
   *  report may still receive it. Submitted injections are also bounded. */
  const prune = (): void => {
    if (sessions.size > 0) injections = injections.filter((injection) => [...sessions.values()].some((session) => !session.used.has(injection.at)));
    const submitted = injections.filter((injection) => injection.submitted);
    const excess = new Set(submitted.slice(0, Math.max(0, submitted.length - MAX_WAITING_SUBMITTED)));
    if (excess.size > 0) injections = injections.filter((injection) => !excess.has(injection));
  };
  const use = (session: Session, injection: Injection): void => {
    session.used.add(injection.at);
    prune();
  };
  /** A prompt uses up the injection it matches. One that matches none uses up every waiting Insert: Inserts land in
   *  the one input box, so that prompt is all of them, perhaps edited. A submitted injection comes back with its own
   *  text, so only that text uses it up. */
  const take = (session: Session, prompt: string): PromptMatch => {
    const text = promptText(prompt);
    const waiting = pendingFor(session);
    const matched = waiting.find((injection) => injection.text === text);
    if (matched !== undefined) {
      use(session, matched);
      return 'injected';
    }
    const inserts = waiting.filter((injection) => !injection.submitted);
    if (inserts.length === 0) return 'none';
    for (const insert of inserts) use(session, insert);
    return 'unmatched';
  };
  /** A built-in command Claude Code runs reports no prompt, so its own report uses up its injection. */
  const takeCommand = (session: Session, matches: (text: string) => boolean): void => {
    const injection = pendingFor(session).find((waiting) => matches(waiting.text));
    if (injection !== undefined) use(session, injection);
  };

  const drop = (session: Session, reason: string): void => {
    const pending = session.pending;
    delete session.pending;
    pending?.delivered?.(reason);
  };

  const recipientOf = deps.recipientOf ?? (() => 'session');
  const cancelInterruptedSends = (): void => {
    for (const [id, session] of sessions) {
      if (session.pending && recipientOf(id, session.tmux) !== session.pending.recipient) drop(session, 'the calling session is no longer the terminal recipient.');
    }
  };

  const knownOrigin = (session: Session, turn: Turn, launch: SessionLaunch | null, match: PromptMatch): TurnOrigin | null => {
    if (match === 'injected') return 'not-human';
    if (launch?.print === true || (launch?.launchPrompt === true && session.started && turn.ordinal === 1)) return 'not-human';
    if (launch === null || (launch.launchPrompt && !session.started) || match === 'unmatched') return 'undetermined';
    return null;
  };

  const auditTranscript = (session: Session, turn: Turn): string | null => {
    if (turn.auditOrigin === 'human' || turn.auditOrigin === 'not-human') return null;
    const known = knownOrigin(session, turn, turn.auditLaunch ?? null, turn.auditMatch);
    if (known !== null || !session.transcriptPath || !path.isAbsolute(session.transcriptPath)) return null;
    return session.transcriptPath;
  };
  const reportTranscriptFailure = (turn: Turn, error: unknown): void => {
    if (isErrno(error, 'ENOENT')) { delete turn.transcriptFailures; return; }
    const reason = errMsg(error);
    const failures = turn.transcriptFailures ??= new Set<string>();
    if (!failures.has(reason)) {
      failures.add(reason);
      console.error(`Transcript observation failed: ${reason}`);
    }
  };
  const discover = async (session: Session, turn: Turn): Promise<void> => {
    const file = auditTranscript(session, turn);
    if (!file) return;
    try {
      const result = await readTranscript(file, turn.promptId, turn.prompt, { unchangedVersion: turn.auditVersion, signal: auditDiscovery.signal, scope: 'historical' });
      delete turn.transcriptFailures;
      if (result && turn.auditOrigin !== 'human' && turn.auditOrigin !== 'not-human') {
        turn.auditOrigin = result.origin;
        turn.auditVersion = result.version;
      }
    } catch (error) { if (!auditDiscovery.signal.aborted) reportTranscriptFailure(turn, error); }
  };

  const turns: SessionTurns = {
    cancelAuditDiscovery() { auditDiscovery.abort(); },
    async discoverHumanPrompts() {
      const prompts: Extract<AuditEvent, { type: 'mcp.prompt' }>[] = [];
      await Promise.all([...sessions.values()].map(async session => {
        const turn = session.turn;
        if (!turn || turn === 'unknown') return;
        if (turn.auditDiscovery) await turn.auditDiscovery;
        turn.auditDiscovery ??= discover(session, turn).finally(() => { delete turn.auditDiscovery; });
        await turn.auditDiscovery;
        if (turn.auditOrigin === 'human') prompts.push({ ...turn.auditPrompt });
      }));
      return prompts;
    },
    cancelInterruptedSends,
    cancelPending(reason) { for (const session of sessions.values()) drop(session, reason); },
    prompt(id) {
      const turn = sessions.get(id)?.turn;
      return turn && turn !== 'unknown' ? { ...turn.auditPrompt } : null;
    },
    acceptSend(id, todo, persist, delivered) {
      const session = sessions.get(id);
      if (!session || !session.turn || session.turn === 'unknown') return 'the calling turn is no longer open.';
      if (session.turn.sentTodoId !== undefined) return `todo ${JSON.stringify(session.turn.sentTodoId)} was already accepted in this turn.`;
      const recipient = recipientOf(id, session.tmux);
      if (recipient === null) return 'the calling session is no longer the terminal recipient.';
      persist?.();
      session.turn.sentTodoId = todo.id;
      session.pending = { ...todo, turn: session.turn, ready: false, recipient, delivered };
      return null;
    },
    deliverPending(idle, inject) {
      cancelInterruptedSends();
      for (const [id, session] of sessions) {
        if (!idle || !session.pending?.ready || session.pending.delivering || session.turn !== null) continue;
        const pending = session.pending;
        pending.delivering = true;
        inject(pending.text, id, pending.recipient, session.tmux, {
          canReceive: () => session.pending === pending && recipientOf(id, session.tmux) === pending.recipient,
          finish: reason => {
            if (session.pending !== pending) return;
            delete session.pending;
            pending.delivered?.(reason);
          },
        });
      }
    },
    hook(id, input, tmux) {
      const report = parseHookReport(input);
      if (report === 'ignored') return;
      if (report !== null && report.event === 'SessionStart' && report.source === 'startup') {
        const previous = sessions.get(id);
        if (previous) drop(previous, 'the calling session restarted.');
        sessions.set(id, fresh());
      }
      const session = sessions.get(id) ?? fresh();
      sessions.set(id, session);
      session.tmux = tmux;
      if (report === null) {
        session.turn = 'unknown';
        return;
      }
      session.transcriptPath = report.transcriptPath;
      switch (report.event) {
        case 'SessionStart':
          session.turn = null;
          if (report.source === 'startup' || report.source === 'resume') {
            session.turns = 0;
            session.started = true;
          }
          if (report.source === 'clear') takeCommand(session, (text) => text === '/clear');
          if (report.source === 'compact') takeCommand(session, (text) => text === '/compact' || text.startsWith('/compact '));
          return;
        case 'SessionEnd':
          drop(session, 'the calling session ended.');
          session.turn = null;
          if (report.reason !== 'clear') {
            sessions.delete(id);
            prune();
          }
          return;
        case 'Stop':
          if (session.pending?.turn === session.turn) session.pending.ready = true;
          session.turn = null;
          return;
        case 'UserPromptSubmit': {
          const match = take(session, report.prompt);
          const open = session.turn;
          if (open !== null && open !== 'unknown' && open.promptId === report.promptId) {
            if (match === 'injected' || (match === 'unmatched' && open.match === 'none')) open.match = match;
            return;
          }
          drop(session, 'a new prompt interrupted delivery.');
          session.turns += 1;
          session.turn = { auditMatch: match, auditPrompt: { type: 'mcp.prompt', id: randomUUID(), text: report.prompt, ts: new Date().toISOString() }, promptId: report.promptId, prompt: promptText(report.prompt), ordinal: session.turns, injectionsAtStart: count, match };
          return;
        }
        default:
          return report satisfies never;
      }
    },
    injected(text, opts) {
      const injection = promptText(text);
      if (injection === '') return;
      for (const [id, session] of sessions) {
        if (session.turn === null && id !== opts?.sendingSession) drop(session, 'an app injection interrupted delivery.');
      }
      count += 1;
      injections.push({ at: count, text: injection, submitted: opts?.submitted ?? false });
      prune();
    },
    async origin(id) {
      const session = sessions.get(id);
      const turn = session?.turn;
      if (session === undefined || turn === undefined || turn === null || turn === 'unknown') return 'undetermined';
      if (turn.match === 'injected') return 'not-human';
      const launch = await deps.launchOf(id);
      if (launch !== null && sessions.get(id) === session && session.turn === turn) turn.auditLaunch = launch;
      const currentOrigin = (): TurnOrigin | null => {
        if (sessions.get(id) !== session || session.turn !== turn) return 'undetermined';
        const known = knownOrigin(session, turn, launch, turn.match);
        if (known !== null) return known;
        return pendingFor(session).some(injection => injection.at > turn.injectionsAtStart) ? 'undetermined' : null;
      };
      const known = currentOrigin();
      if (known !== null) return known;
      const transcriptPath = session.transcriptPath;
      if (transcriptPath === null || !path.isAbsolute(transcriptPath)) return 'undetermined';
      try {
        const result = await readTranscript(transcriptPath, turn.promptId, turn.prompt);
        delete turn.transcriptFailures;
        return currentOrigin() ?? result?.origin ?? 'undetermined';
      } catch (error) { reportTranscriptFailure(turn, error); return 'undetermined'; }
    },
  };
  return turns;
}

const PS_TIMEOUT_MS = 1000;

/** The flags of Claude Code's command line that always take the next word as their value. A flag whose value is
 *  optional is left out: reading its value as a launch prompt only ever refuses more. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--model', '--fallback-model', '--permission-mode', '--append-system-prompt', '--system-prompt', '--add-dir', '--settings',
  '--setting-sources', '--output-format', '--input-format', '--mcp-config', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--agents', '--agent', '--session-id', '--max-turns', '--permission-prompt-tool',
  '--betas', '--plugin-dir', '--max-budget-usd',
]);

/** The flags whose optional value is never a prompt: Claude Code reads the word after `--resume` as the session to
 *  resume. */
const RESUME_FLAGS: ReadonlySet<string> = new Set(['-r', '--resume']);

/** Where Claude Code's own arguments start in a command line: after the `claude` program, run directly or by an
 *  interpreter. */
function claudeProgramAt(words: readonly string[]): number {
  return words.findIndex((word) => path.basename(word) === 'claude' || /[\\/]claude-code[\\/]cli\.m?js$/.test(word));
}

/** How the session whose command line is `args` was launched, or null when the line is not Claude Code's. A flag
 *  value with a space in it reads as a launch prompt, which only ever refuses more. */
export function parseSessionLaunch(args: string): SessionLaunch | null {
  const words = args.trim().split(/\s+/);
  const at = claudeProgramAt(words);
  if (at < 0) return null;
  let print = false;
  let launchPrompt = false;
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i];
    if (word === '-p' || word === '--print') print = true;
    else if (VALUE_FLAGS.has(word)) i++;
    else if (RESUME_FLAGS.has(word)) {
      if (words[i + 1] !== undefined && !words[i + 1].startsWith('-')) i++;
    }
    else if (!word.startsWith('-')) launchPrompt = true;
  }
  return { print, launchPrompt };
}

/** The launch of the Claude Code session that is process `session`, read from the process table; null when it
 *  cannot be read. */
export function readSessionLaunch(session: number): Promise<SessionLaunch | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'args=', '-p', String(session)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : parseSessionLaunch(stdout));
    });
  });
}
