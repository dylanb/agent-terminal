import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpBuildId } from '../../src/main/mcpBuildId';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function serverScript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-term-mcp-build-'));
  dirs.push(dir);
  const file = join(dir, 'mcp.js');
  writeFileSync(file, content);
  return file;
}

describe('the build a window and its MCP server each name on the bridge', () => {
  it('is the same for two copies of one server script, and differs once the script changes', () => {
    const shipped = 'export const protocol = 1;\n';
    expect({
      sameBuildElsewhere: mcpBuildId(serverScript(shipped)) === mcpBuildId(serverScript(shipped)),
      reinstalled: mcpBuildId(serverScript(shipped)) === mcpBuildId(serverScript('export const protocol = 2;\n')),
    }).toEqual({ sameBuildElsewhere: true, reinstalled: false });
  });
});
