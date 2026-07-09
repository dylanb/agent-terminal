import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, sessionLogDir, readSessionTokens } from '../../src/main/costMeter';

it('the source file carries no raw control bytes, so git keeps it text (diffable/reviewable)', () => {
  // The per-message dedup key's separator must be spelled as an escape (\x00), not embedded as a raw NUL —
  // a single raw NUL makes git classify the .ts as binary and drop it from every diff (cf. findingSignature.ts).
  const bytes = readFileSync(new URL('../../src/main/costMeter.ts', import.meta.url));
  const control = [...bytes].filter((b) => b < 9 || (b > 13 && b < 32));
  expect(control).toEqual([]);
});

// §26.10 — the meter recovers per-model token totals from Claude Code's session JSONL logs (the same data
// `cache-analyze` reads). The layout is Claude Code's private format, so every accessor degrades on drift.
describe('session-log token recovery (§26.10)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'costmeter-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const line = (model: string, u: Partial<Record<string, number>>): string =>
    JSON.stringify({ type: 'assistant', message: { model, usage: u } });

  it('sums usage per model across every *.jsonl line in the dir', () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        line('claude-sonnet-5', { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 }),
        line('claude-sonnet-5', { input_tokens: 200, output_tokens: 30 }),
        line('claude-opus-4-8', { input_tokens: 1, output_tokens: 2 }),
      ].join('\n'),
    );
    expect(readSessionTokens(dir)).toEqual([
      { model: 'claude-opus-4-8', input: 1, cacheCreate: 0, cacheRead: 0, output: 2 },
      { model: 'claude-sonnet-5', input: 300, cacheCreate: 10, cacheRead: 5, output: 50 },
    ]);
  });

  it('reads the main session AND subagent logs (every *.jsonl file under the dir)', () => {
    writeFileSync(join(dir, 'main.jsonl'), line('claude-sonnet-5', { input_tokens: 100 }));
    writeFileSync(join(dir, 'subagent-review.jsonl'), line('claude-sonnet-5', { output_tokens: 40 }));
    expect(readSessionTokens(dir)).toEqual([
      { model: 'claude-sonnet-5', input: 100, cacheCreate: 0, cacheRead: 0, output: 40 },
    ]);
  });

  it('degrades silently: an unparseable line, a non-assistant line, and missing fields are skipped', () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        'not json {{{',
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }), // no usage
        JSON.stringify({ message: { usage: { input_tokens: 5 } } }), // no model string
        line('claude-sonnet-5', { input_tokens: 7 }),
        '',
      ].join('\n'),
    );
    expect(readSessionTokens(dir)).toEqual([{ model: 'claude-sonnet-5', input: 7, cacheCreate: 0, cacheRead: 0, output: 0 }]);
  });

  it('a non-.jsonl file is ignored', () => {
    writeFileSync(join(dir, 'notes.txt'), line('claude-sonnet-5', { input_tokens: 999 }));
    expect(readSessionTokens(dir)).toEqual([]);
  });

  it('an absent log dir yields an empty set (never throws)', () => {
    expect(readSessionTokens(join(dir, 'does-not-exist'))).toEqual([]);
  });

  // Claude Code identifies one billed API turn by `message.id` + `requestId`. Resuming or forking a session
  // copies the prior turns verbatim into the new session file, so the same billed turn appears in several
  // *.jsonl. Counting each appearance multiplies the run's dollars by the number of resumes.
  it('counts a billed turn once, however many session files replay it', () => {
    const turn = JSON.stringify({
      requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 20 } },
    });
    writeFileSync(join(dir, 'original.jsonl'), turn);
    writeFileSync(join(dir, 'resumed.jsonl'), [turn, turn].join('\n')); // a resume replays it, twice over
    expect(readSessionTokens(dir)).toEqual([
      { model: 'claude-sonnet-5', input: 100, cacheCreate: 0, cacheRead: 0, output: 20 },
    ]);
  });

  it('distinct turns are all counted, even when one field of the identity repeats', () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        JSON.stringify({ requestId: 'req_1', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 1 } } }),
        JSON.stringify({ requestId: 'req_2', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 10 } } }),
        JSON.stringify({ requestId: 'req_2', message: { id: 'msg_2', model: 'claude-sonnet-5', usage: { input_tokens: 100 } } }),
      ].join('\n'),
    );
    expect(readSessionTokens(dir)[0].input).toBe(111);
  });

  it('an unidentifiable turn (no message.id) is still counted', () => {
    writeFileSync(
      join(dir, 'session.jsonl'),
      [line('claude-sonnet-5', { input_tokens: 3 }), line('claude-sonnet-5', { input_tokens: 4 })].join('\n'),
    );
    expect(readSessionTokens(dir)[0].input).toBe(7);
  });

  // §26 — the reviewer personas run as subagents, whose logs live under <session-uuid>/subagents/agent-*.jsonl.
  // A flat read of the project dir misses the entire fan-out, the bulk of an iteration's cost.
  it('reads reviewer-subagent logs nested under the session dir, not just the top level', () => {
    writeFileSync(join(dir, 'main.jsonl'), line('claude-sonnet-5', { input_tokens: 100 }));
    const subagents = join(dir, 'session-uuid', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-abc.jsonl'), line('claude-sonnet-5', { output_tokens: 40 }));
    expect(readSessionTokens(dir)).toEqual([
      { model: 'claude-sonnet-5', input: 100, cacheCreate: 0, cacheRead: 0, output: 40 },
    ]);
  });
});

// §26.10 — the meter reports THE RUN's cost. The project dir accumulates every session ever run against the
// repo, so without a lower bound the readout is the repo's lifetime spend, not the flow's.
describe('scoping the meter to the run (§26.10)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'costmeter-since-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (timestamp: string, input: number): string =>
    JSON.stringify({ timestamp, message: { model: 'claude-sonnet-5', usage: { input_tokens: input } } });

  const FLOW_START = Date.parse('2026-07-09T12:00:00.000Z');

  it('skips turns older than the given instant', () => {
    writeFileSync(join(dir, 'session.jsonl'), [at('2026-07-01T00:00:00.000Z', 5000), at('2026-07-09T12:00:01.000Z', 7)].join('\n'));
    expect(readSessionTokens(dir, FLOW_START)[0].input).toBe(7);
  });

  it('counts a turn exactly at the instant', () => {
    writeFileSync(join(dir, 'session.jsonl'), at('2026-07-09T12:00:00.000Z', 7));
    expect(readSessionTokens(dir, FLOW_START)[0].input).toBe(7);
  });

  it('a turn with no usable timestamp is excluded once a lower bound is given', () => {
    writeFileSync(join(dir, 'session.jsonl'), [at('nonsense', 5000), at('2026-07-09T12:00:01.000Z', 7)].join('\n'));
    expect(readSessionTokens(dir, FLOW_START)[0].input).toBe(7);
  });

  it('with no lower bound every turn counts, timestamped or not', () => {
    writeFileSync(join(dir, 'session.jsonl'), [at('2026-07-01T00:00:00.000Z', 5000), at('nonsense', 7)].join('\n'));
    expect(readSessionTokens(dir)[0].input).toBe(5007);
  });

  it('a run that has produced no turns yet prices to nothing, not to the repo`s history', () => {
    writeFileSync(join(dir, 'session.jsonl'), at('2026-07-01T00:00:00.000Z', 5000));
    expect(readSessionTokens(dir, FLOW_START)).toEqual([]);
  });
});

describe('session-log dir resolution (§26.10)', () => {
  it('encodes a repo path into Claude Code`s project-dir name (non-alphanumerics → dash)', () => {
    expect(encodeProjectDir('/Users/x/src/agent-terminal.one')).toBe('-Users-x-src-agent-terminal-one');
  });

  it('APP_SESSION_LOG_ROOT overrides with the EXACT dir (the L7 test seam)', () => {
    expect(sessionLogDir('/repo', { APP_SESSION_LOG_ROOT: '/tmp/logs' } as NodeJS.ProcessEnv, '/home')).toBe('/tmp/logs');
  });

  it('with no override, resolves ~/.claude/projects/<encoded-repo>', () => {
    expect(sessionLogDir('/repo/foo', {} as NodeJS.ProcessEnv, '/home/me')).toBe(
      join('/home/me', '.claude', 'projects', '-repo-foo'),
    );
  });
});
