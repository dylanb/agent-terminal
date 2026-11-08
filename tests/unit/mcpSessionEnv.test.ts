import { describe, expect, it } from 'vitest';
import { windowSessionEnv } from '../../src/main/mcpSessionEnv';
import { MCP_WINDOW_ENV, APP_MCP_ACK_TIMEOUT_ENV, DEFAULT_MCP_ACK_TIMEOUT_MS, mcpAckTimeoutMs } from '../../src/shared/mcp';

describe("the environment a window's terminal spawns with", () => {
  it("names this window's endpoint, replacing the one a window started inside another inherited", () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/op', [MCP_WINDOW_ENV]: '/app-home/mcp/outer.sock' };
    const env = windowSessionEnv(inherited, '/app-home/mcp/inner.sock');
    expect(env[MCP_WINDOW_ENV]).toBe('/app-home/mcp/inner.sock');
    expect({ PATH: env.PATH, HOME: env.HOME }).toEqual({ PATH: '/usr/bin', HOME: '/home/op' });
  });

  it("names no endpoint when this window's setup failed, even one inherited from an outer window, and keeps every other variable", () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/op', LANG: 'C', [MCP_WINDOW_ENV]: '/app-home/mcp/outer.sock' };
    const env = windowSessionEnv(inherited, null);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/op', LANG: 'C' });
  });

  it('leaves the environment it was given unchanged', () => {
    const inherited = { PATH: '/usr/bin', [MCP_WINDOW_ENV]: '/app-home/mcp/outer.sock' };
    windowSessionEnv(inherited, '/app-home/mcp/inner.sock');
    expect(inherited).toEqual({ PATH: '/usr/bin', [MCP_WINDOW_ENV]: '/app-home/mcp/outer.sock' });
  });
});

describe('the acknowledgement timeout a call waits for its window', () => {
  it('is the named default when the setting is absent or not a positive whole number of milliseconds', () => {
    const settings = [undefined, '', 'soon', '0', '-5', '2.5', '250ms'];
    expect(settings.map((value) => mcpAckTimeoutMs(value === undefined ? {} : { [APP_MCP_ACK_TIMEOUT_ENV]: value }))).toEqual(settings.map(() => DEFAULT_MCP_ACK_TIMEOUT_MS));
  });

  it('is the value APP_MCP_ACK_TIMEOUT_MS sets', () => {
    expect(mcpAckTimeoutMs({ [APP_MCP_ACK_TIMEOUT_ENV]: '250' })).toBe(250);
  });
});
