import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/main/mcpServer';
import { openWindowBridge } from '../../src/main/mcpWindowBridge';
import { createVirtualClock } from '../helpers/virtualClock';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function session(): Promise<{ client: Client; windowCalls: () => number }> {
  const home = mkdtempSync(join(tmpdir(), 'atsrv-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const window = await openWindowBridge({ appHome: home, build: 'b', handle: async () => (calls += 1, { ok: true }) });
  cleanup.push(() => window.close());
  const server = createMcpServer({ endpoint: window.endpoint, build: 'b', ackTimeoutMs: 5_000, timers: createVirtualClock() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  cleanup.push(() => client.close());
  return { client, windowCalls: () => calls };
}

const rejection = (call: Promise<unknown>): Promise<string> => call.then(() => 'answered', (e: unknown) => (e instanceof Error ? e.message : String(e)));

describe("the agent-terminal MCP server's tool calls", () => {
  it('rejects an unknown tool, or arguments a tool does not take, naming the problem, and never reaches the window', async () => {
    const { client, windowCalls } = await session();
    const unknownTool = await rejection(client.callTool({ name: 'approve_everything', arguments: {} }));
    const extraArgument = await rejection(client.callTool({ name: 'read_state', arguments: { x: 1 } }));
    expect({ unknownTool, extraArgument, windowCalls: windowCalls() }).toEqual({
      unknownTool: expect.stringContaining('approve_everything'),
      extraArgument: expect.stringContaining('"x"'),
      windowCalls: 0,
    });
  });

  it('rejects an argument whose name every object inherits, naming it, and never reaches the window', async () => {
    const { client, windowCalls } = await session();
    const inherited = await rejection(client.callTool({ name: 'read_state', arguments: { constructor: 1 } }));
    expect({ inherited, windowCalls: windowCalls() }).toEqual({ inherited: expect.stringContaining('"constructor"'), windowCalls: 0 });
  });

  it('outside a window lists no tools and rejects a call, naming the tool', async () => {
    const server = createMcpServer({ endpoint: null, build: 'b', ackTimeoutMs: 5_000, timers: createVirtualClock() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    cleanup.push(() => client.close());
    const { tools } = await client.listTools();
    const call = await rejection(client.callTool({ name: 'read_state', arguments: {} }));
    expect({ tools, call }).toEqual({ tools: [], call: expect.stringContaining('read_state') });
  });

  it('hands a valid call to the window and returns its answer', async () => {
    const { client, windowCalls } = await session();
    const result = await client.callTool({ name: 'read_state', arguments: {} });
    expect({ isError: result.isError, windowCalls: windowCalls() }).toEqual({ isError: false, windowCalls: 1 });
  });
});
