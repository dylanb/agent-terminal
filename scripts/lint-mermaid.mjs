import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');

function mermaidBlocks(text) {
  const blocks = [];
  let open;
  text.split('\n').forEach((line, i) => {
    if (!open) {
      const m = /^\s*(`{3,}|~{3,})\s*mermaid\s*$/.exec(line);
      if (m) open = { fence: m[1], line: i + 1, body: [] };
    } else if (line.trim().startsWith(open.fence) && line.trim().replace(/[`~]/g, '') === '') {
      blocks.push({ line: open.line, source: open.body.join('\n') });
      open = undefined;
    } else {
      open.body.push(line);
    }
  });
  return blocks;
}

const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let failures = 0;
for (const file of files) {
  for (const block of mermaidBlocks(readFileSync(file, 'utf8'))) {
    try {
      await mermaid.parse(block.source);
    } catch (e) {
      failures += 1;
      console.error(`${file}:${block.line}: Mermaid diagram does not parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
process.exit(failures ? 1 : 0);
