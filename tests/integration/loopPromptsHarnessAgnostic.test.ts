import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// The shipped loop prompts run under whichever coding agent the operator hosts, so they name the repository's
// guidance generically, never one harness's context file.
const SOURCE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );

const HARNESS_SPECIFIC = /claude\.md|agents\.md|\.claude\/|\bclaude\b|\bcodex\b/i;
const GENERIC_GUIDANCE = 'agent context, guidance, standards, and rules files';

const WORKERS_CITING_GUIDANCE = [
  'green-loop', 'groom-loop', 'impl-loop', 'infra-loop', 'integration-slice-loop',
  'plan-bundle-loop', 'plan-loop', 'red-loop', 'refactor-loop',
].map((loop) => `${loop}/prompts/work.md`);
const CONVENTIONS_CHARTERS = ['impl-loop', 'infra-loop', 'integration-slice-loop'].map(
  (loop) => `${loop}/charter/conventions.md`,
);

describe('shipped loop prompts are harness-agnostic', () => {
  for (const file of markdownFiles(SOURCE)) {
    const rel = relative(SOURCE, file);
    it(`${rel} names no harness-specific context file or agent`, () =>
      expect(readFileSync(file, 'utf8')).not.toMatch(HARNESS_SPECIFIC));
  }

  for (const rel of [...WORKERS_CITING_GUIDANCE, ...CONVENTIONS_CHARTERS]) {
    it(`${rel} defers to the repository's guidance files generically`, () =>
      expect(readFileSync(join(SOURCE, rel), 'utf8').replace(/\s+/g, ' ')).toContain(GENERIC_GUIDANCE));
  }
});
