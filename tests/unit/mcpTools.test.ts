import { describe, expect, it } from 'vitest';
import { mcpToolNames, toolResult, type McpToolResult } from '../../src/main/mcpTools';

const CLAUDE_CODE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const text = (result: McpToolResult): string => result.content.map((c) => c.text).join('\n');

describe('the tools the agent-terminal MCP server lists', () => {
  it('are the tools this build supports, each named as Claude Code accepts', () => {
    const names = mcpToolNames();
    expect(names).toEqual(['read_state']);
    expect(names.filter((name) => !CLAUDE_CODE_TOOL_NAME.test(name))).toEqual([]);
  });
});

describe('what a tool call returns for each outcome of its window call', () => {
  it('a success with its result, app unreachable as a refusal, and result unknown as neither', () => {
    const answered = toolResult({ kind: 'answered', value: { window: { id: 'window-7' } } });
    const unreachable = toolResult({ kind: 'app-unreachable', reason: 'no window to reach' });
    const unknown = toolResult({ kind: 'result-unknown', reason: 'the connection was lost' });
    expect({
      answered: { isError: answered.isError, text: text(answered) },
      unreachable: { isError: unreachable.isError, text: text(unreachable) },
      unknown: { isError: unknown.isError, text: text(unknown), saysUnreachable: /app unreachable/i.test(text(unknown)) },
    }).toEqual({
      answered: { isError: false, text: expect.stringContaining('window-7') },
      unreachable: { isError: true, text: expect.stringMatching(/app unreachable/i) },
      unknown: { isError: true, text: expect.stringMatching(/result unknown/i), saysUnreachable: false },
    });
  });
});

describe('the outcome kind a tool result carries', () => {
  it('names success, app unreachable and result unknown apart', () => {
    const kindOf = (result: McpToolResult): unknown => (JSON.parse(text(result)) as { kind?: unknown }).kind;
    expect({
      answered: kindOf(toolResult({ kind: 'answered', value: { window: { id: 'window-7' } } })),
      unreachable: kindOf(toolResult({ kind: 'app-unreachable', reason: 'no window to reach' })),
      unknown: kindOf(toolResult({ kind: 'result-unknown', reason: 'the connection was lost' })),
    }).toEqual({ answered: 'success', unreachable: 'app-unreachable', unknown: 'result-unknown' });
  });
});
