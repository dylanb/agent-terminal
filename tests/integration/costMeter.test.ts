import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, sessionLogDir, readSessionTokens } from '../../src/main/costMeter';

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
