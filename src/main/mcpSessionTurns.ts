import { matchesInjectedPrompt, observeTranscript, promptText, type ObserveTranscript, type TranscriptObservation } from './mcpTranscript';
import { randomUUID } from 'node:crypto';
import type { SessionPrompt } from './sessionPrompt';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { McpTmux } from '../shared/mcpBridge';
import type { TurnOrigin } from '../shared/turnOrigin';
import { errMsg, isErrno } from './errno';

export interface SessionLaunch {
  print: boolean;
  launchPrompt: boolean;
}

export type OriginObservation =
  | { origin: 'human'; prompt: SessionPrompt }
  | { origin: 'not-human' | 'undetermined'; prompt: null };

export interface SessionTurns {
  hook(session: number, input: unknown, tmux?: McpTmux): void;
  injected(text: string, opts?: { submitted: boolean; sendingSession?: number }): void;
  observe<T>(session: number | null, use: (observation: OriginObservation) => T | Promise<T>): Promise<T>;
  prompt(session: number): SessionPrompt | null;
  cancelPending(reason: string): void;
  cancelAuditDiscovery(): void;
  discoverHumanPrompts(): Promise<SessionPrompt[]>;
  acceptSend(session: number, todo: { id: string; text: string }, persist?: () => void, delivered?: (reason?: string) => void): string | null;
  cancelInterruptedSends(): void;
  deliverPending(idle: boolean, inject: (text: string, session: number, recipient: string, tmux: McpTmux | undefined, delivery: { canReceive(): boolean; finish(reason?: string): void }) => void): void;
}

type PromptMatch = 'injected' | 'unmatched' | 'none';

interface Turn {
  auditLaunch?: SessionLaunch;
  auditMatch: PromptMatch;
  auditOrigin?: TurnOrigin;
  transcriptFailures?: Set<string>;
  auditVersion?: string;
  auditDiscovery?: Promise<void>;
  observedPrompt: SessionPrompt;
  messages: Map<string, SessionPrompt>;
  seenMessages: Set<string>;
  queuedInjections: string[];
  promptId: string;
  prompt: string;
  ordinal: number;
  injectionsAtStart: number;
  match: PromptMatch;
  sentTodoId?: string;
}

type SessionState =
  | { kind: 'idle' }
  | { kind: 'unknown' }
  | { kind: 'active'; turn: Turn };

interface PendingSend {
  id: string;
  text: string;
  recipient: string;
  delivered?: (reason?: string) => void;
}

type DeliveryState =
  | { kind: 'none' }
  | { kind: 'waiting-stop'; send: PendingSend; turn: Turn }
  | { kind: 'ready'; send: PendingSend }
  | { kind: 'delivering'; send: PendingSend };

const activeTurn = (session: Session | undefined): Turn | undefined =>
  session?.state.kind === 'active' ? session.state.turn : undefined;

interface Session {
  tmux?: McpTmux;
  transcriptPath: string | null;
  state: SessionState;
  turns: number;
  started: boolean;
  used: Set<number>;
  delivery: DeliveryState;
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

const MAX_WAITING_SUBMITTED = 64;

export function createSessionTurns(deps: { observeTranscript?: ObserveTranscript; launchOf: (session: number) => Promise<SessionLaunch | null>; recipientOf?: (session: number, tmux?: McpTmux) => string | null }): SessionTurns {
  const observe = deps.observeTranscript ?? observeTranscript;
  const sessions = new Map<number, Session>();
  const auditDiscovery = new AbortController();
  let injections: Injection[] = [];
  let count = 0;

  const fresh = (): Session => ({ transcriptPath: null, state: { kind: 'idle' }, delivery: { kind: 'none' }, turns: 0, started: false, used: new Set() });
  const pendingFor = (session: Session): Injection[] => injections.filter((injection) => !session.used.has(injection.at));
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
  const take = (session: Session, prompt: string): PromptMatch => {
    const waiting = pendingFor(session);
    const matched = waiting.find((injection) => matchesInjectedPrompt(injection.text, prompt));
    if (matched !== undefined) {
      use(session, matched);
      return 'injected';
    }
    const inserts = waiting.filter((injection) => !injection.submitted);
    if (inserts.length === 0) return 'none';
    for (const insert of inserts) use(session, insert);
    return 'unmatched';
  };
  // Claude Code built-in commands report no UserPromptSubmit event.
  const takeCommand = (session: Session, matches: (text: string) => boolean): void => {
    const injection = pendingFor(session).find((waiting) => matches(waiting.text));
    if (injection !== undefined) use(session, injection);
  };

  const drop = (session: Session, reason: string): void => {
    const delivery = session.delivery;
    session.delivery = { kind: 'none' };
    if (delivery.kind !== 'none') delivery.send.delivered?.(reason);
  };

  const recipientOf = deps.recipientOf ?? (() => 'session');
  const cancelInterruptedSends = (): void => {
    for (const [id, session] of sessions) {
      if (session.delivery.kind !== 'none' && recipientOf(id, session.tmux) !== session.delivery.send.recipient) drop(session, 'the calling session is no longer the terminal recipient.');
    }
  };

  const knownOrigin = (session: Session, turn: Turn, launch: SessionLaunch | null, match: PromptMatch): TurnOrigin | null => {
    if (match === 'injected') return 'not-human';
    if (launch?.print === true || (launch?.launchPrompt === true && session.started && turn.ordinal === 1)) return 'not-human';
    if (launch === null || (launch.launchPrompt && !session.started) || match === 'unmatched') return 'undetermined';
    return null;
  };

  const auditTranscript = (session: Session): string | null => {
    if (!session.transcriptPath || !path.isAbsolute(session.transcriptPath)) return null;
    return session.transcriptPath;
  };
  const rememberMessages = (session: Session, turn: Turn, result: TranscriptObservation): void => {
    for (const message of result.messages ?? []) {
      if (turn.seenMessages.has(message.id)) continue;
      turn.seenMessages.add(message.id);
      const matched = turn.queuedInjections.findIndex(text => matchesInjectedPrompt(text, message.text));
      if (matched !== -1) {
        turn.queuedInjections.splice(matched, 1);
        continue;
      }
      if (pendingFor(session).some(injection => matchesInjectedPrompt(injection.text, message.text))) continue;
      const id = `${turn.observedPrompt.turnId}:${message.id}`;
      turn.messages.set(id, { ...message, id, turnId: turn.observedPrompt.turnId });
    }
  };
  const latestPrompt = (turn: Turn): SessionPrompt => [...turn.messages.values()].at(-1) ?? turn.observedPrompt;
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
    const file = auditTranscript(session);
    if (!file) return;
    try {
      const result = await observe({ file, promptId: turn.promptId, prompt: turn.prompt, unchangedVersion: turn.auditVersion, signal: auditDiscovery.signal, scope: 'historical' });
      delete turn.transcriptFailures;
      if (result) {
        if (turn.auditOrigin !== 'human' && turn.auditOrigin !== 'not-human') {
          turn.auditOrigin = knownOrigin(session, turn, turn.auditLaunch ?? null, turn.auditMatch) ?? result.origin;
        }
        rememberMessages(session, turn, result);
        turn.auditVersion = result.version;
      }
    } catch (error) { if (!auditDiscovery.signal.aborted) reportTranscriptFailure(turn, error); }
  };

  const turns: SessionTurns = {
    cancelAuditDiscovery() { auditDiscovery.abort(); },
    async discoverHumanPrompts() {
      const prompts: SessionPrompt[] = [];
      await Promise.all([...sessions.values()].map(async session => {
        const turn = activeTurn(session);
        if (!turn) return;
        if (turn.auditDiscovery) await turn.auditDiscovery;
        turn.auditDiscovery ??= discover(session, turn).finally(() => { delete turn.auditDiscovery; });
        await turn.auditDiscovery;
        if (turn.auditOrigin === 'human') prompts.push({ ...turn.observedPrompt });
        prompts.push(...[...turn.messages.values()].map(message => ({ ...message })));
      }));
      return prompts;
    },
    cancelInterruptedSends,
    cancelPending(reason) { for (const session of sessions.values()) drop(session, reason); },
    prompt(id) {
      const turn = activeTurn(sessions.get(id));
      return turn ? { ...turn.observedPrompt } : null;
    },
    acceptSend(id, todo, persist, delivered) {
      const session = sessions.get(id);
      const turn = activeTurn(session);
      if (!session || !turn) return 'the calling turn is no longer open.';
      if (turn.sentTodoId !== undefined) return `todo ${JSON.stringify(turn.sentTodoId)} was already accepted in this turn.`;
      const recipient = recipientOf(id, session.tmux);
      if (recipient === null) return 'the calling session is no longer the terminal recipient.';
      persist?.();
      turn.sentTodoId = todo.id;
      session.delivery = { kind: 'waiting-stop', turn, send: { ...todo, recipient, delivered } };
      return null;
    },
    deliverPending(idle, inject) {
      cancelInterruptedSends();
      for (const [id, session] of sessions) {
        if (!idle || session.delivery.kind !== 'ready' || session.state.kind !== 'idle') continue;
        const { send } = session.delivery;
        const delivering: DeliveryState = { kind: 'delivering', send };
        session.delivery = delivering;
        inject(send.text, id, send.recipient, session.tmux, {
          canReceive: () => session.delivery === delivering && recipientOf(id, session.tmux) === send.recipient,
          finish: reason => {
            if (session.delivery !== delivering) return;
            session.delivery = { kind: 'none' };
            send.delivered?.(reason);
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
        session.state = { kind: 'unknown' };
        return;
      }
      session.transcriptPath = report.transcriptPath;
      switch (report.event) {
        case 'SessionStart':
          session.state = { kind: 'idle' };
          if (report.source === 'startup' || report.source === 'resume') {
            session.turns = 0;
            session.started = true;
          }
          if (report.source === 'clear') takeCommand(session, (text) => text === '/clear');
          if (report.source === 'compact') takeCommand(session, (text) => text === '/compact' || text.startsWith('/compact '));
          return;
        case 'SessionEnd':
          drop(session, 'the calling session ended.');
          session.state = { kind: 'idle' };
          if (report.reason !== 'clear') {
            sessions.delete(id);
            prune();
          }
          return;
        case 'Stop':
          if (session.delivery.kind === 'waiting-stop' && session.delivery.turn === activeTurn(session)) {
            session.delivery = { kind: 'ready', send: session.delivery.send };
          }
          session.state = { kind: 'idle' };
          return;
        case 'UserPromptSubmit': {
          const match = take(session, report.prompt);
          const open = activeTurn(session);
          if (open?.promptId === report.promptId) {
            if (match === 'injected') open.queuedInjections.push(promptText(report.prompt));
            if (match === 'injected' || (match === 'unmatched' && open.match === 'none')) open.match = match;
            return;
          }
          drop(session, 'a new prompt interrupted delivery.');
          session.turns += 1;
          const id = randomUUID();
          session.state = { kind: 'active', turn: { auditMatch: match, observedPrompt: { id, turnId: id, text: report.prompt, occurredAt: new Date().toISOString() }, messages: new Map(), seenMessages: new Set(), queuedInjections: [], promptId: report.promptId, prompt: promptText(report.prompt), ordinal: session.turns, injectionsAtStart: count, match } };
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
        if (session.state.kind === 'idle' && id !== opts?.sendingSession) drop(session, 'an app injection interrupted delivery.');
      }
      count += 1;
      injections.push({ at: count, text: injection, submitted: opts?.submitted ?? false });
      prune();
    },
    async observe(id, use) {
      if (id === null) return use({ origin: 'undetermined', prompt: null });
      const session = sessions.get(id);
      const turn = activeTurn(session);
      if (session === undefined || turn === undefined) return use({ origin: 'undetermined', prompt: null });
      const finish = (origin: TurnOrigin) => use(origin === 'human' ? { origin, prompt: { ...latestPrompt(turn) } } : { origin, prompt: null });
      if (turn.match === 'injected') return finish('not-human');
      const launch = await deps.launchOf(id);
      if (launch !== null && sessions.get(id) === session && activeTurn(session) === turn) turn.auditLaunch = launch;
      const currentOrigin = (): TurnOrigin | null => {
        if (sessions.get(id) !== session || activeTurn(session) !== turn) return 'undetermined';
        const known = knownOrigin(session, turn, launch, turn.match);
        if (known !== null) return known;
        return pendingFor(session).some(injection => injection.at > turn.injectionsAtStart) ? 'undetermined' : null;
      };
      const known = currentOrigin();
      if (known !== null) return finish(known);
      const transcriptPath = session.transcriptPath;
      if (transcriptPath === null || !path.isAbsolute(transcriptPath)) return finish('undetermined');
      let origin: TurnOrigin;
      try {
        const result = await observe({ file: transcriptPath, promptId: turn.promptId, prompt: turn.prompt });
        if (result) rememberMessages(session, turn, result);
        delete turn.transcriptFailures;
        origin = currentOrigin() ?? result?.origin ?? 'undetermined';
      } catch (error) { reportTranscriptFailure(turn, error); origin = 'undetermined'; }
      return finish(origin);
    },
  };
  return turns;
}

const PS_TIMEOUT_MS = 1000;

// Treating an optional flag value as a launch prompt fails closed rather than authorizing a generated turn.
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--model', '--fallback-model', '--permission-mode', '--append-system-prompt', '--system-prompt', '--add-dir', '--settings',
  '--setting-sources', '--output-format', '--input-format', '--mcp-config', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--agents', '--agent', '--session-id', '--max-turns', '--permission-prompt-tool',
  '--betas', '--plugin-dir', '--max-budget-usd',
]);

// Claude Code treats the word after --resume as a session identifier, never as a prompt.
const RESUME_FLAGS: ReadonlySet<string> = new Set(['-r', '--resume']);

function claudeProgramAt(words: readonly string[]): number {
  return words.findIndex((word) => path.basename(word) === 'claude' || /[\\/]claude-code[\\/]cli\.m?js$/.test(word));
}

// ps does not retain argv quoting; a spaced flag value can look like a launch prompt and must fail closed.
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

export function readSessionLaunch(session: number): Promise<SessionLaunch | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'args=', '-p', String(session)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : parseSessionLaunch(stdout));
    });
  });
}
