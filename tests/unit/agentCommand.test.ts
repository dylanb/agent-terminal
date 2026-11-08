import { describe, expect, it } from 'vitest';
import { runsAgentCommand } from '../../src/main/agentCommand';

const AGENTS = ['claude', 'codex'];

describe('runsAgentCommand — does a command line start a listed agent', () => {
  const cases: [string, boolean][] = [
    ['claude', true],
    ['codex --model gpt-5', true],
    ['/usr/local/bin/claude', true],
    ['FOO=1 BAR="a b" codex', true],
    ['cd /work/repo; claude', true],
    ['cd /work/repo && codex', true],
    ['  claude  ', true],
    ['ls', false],
    ['cd claude-notes', false],
    ['git log --grep claude', false],
    ['claudette', false],
    ['echo "x; claude"', false],
    ["echo 'a && codex'", false],
    ['', false],
  ];
  for (const [line, expected] of cases) {
    it(`${JSON.stringify(line)} → ${expected}`, () => {
      expect(runsAgentCommand(line, AGENTS)).toBe(expected);
    });
  }

  it('matches only the names it is given', () => {
    expect({ listed: runsAgentCommand('fake-agent', ['fake-agent']), unlisted: runsAgentCommand('claude', ['fake-agent']) }).toEqual({
      listed: true,
      unlisted: false,
    });
  });
});
