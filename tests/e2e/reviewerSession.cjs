const { readFileSync, readdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { load } = require('js-yaml');
const { isDeepStrictEqual } = require('node:util');

const [action, state, expectations, evidence, line] = process.argv.slice(2);
if (action === 'start') {
  const root = join(process.cwd(), '.claude', 'agents');
  let files;
  try {
    files = readdirSync(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  const loaded = {};
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const text = readFileSync(join(root, file), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    if (!match) continue;
    const front = load(match[1]);
    loaded[front.name] = { name: front.name, charter: match[2], tools: front.tools === undefined ? 'all' : front.tools.split(',').map((tool) => tool.trim()) };
  }
  writeFileSync(state, JSON.stringify(loaded));
} else if (action === 'review') {
  const match = /^- (\S+) — subagent_type: (\S+)\s*$/.exec(line);
  if (!match) process.exit(0);
  const expected = JSON.parse(readFileSync(expectations, 'utf8')).find((entry) => entry.name === match[2]);
  const loaded = JSON.parse(readFileSync(state, 'utf8'))[match[2]];
  if (!expected || expected.persona !== match[1] || !loaded || !isDeepStrictEqual(loaded, { name: expected.name, charter: expected.charter, tools: expected.tools })) {
    throw new Error(`reviewer ${match[2]} was not loaded with the expected charter and tools`);
  }
  appendFileSync(evidence, JSON.stringify(loaded) + '\n');
} else {
  throw new Error(`unknown reviewer session action: ${action}`);
}
