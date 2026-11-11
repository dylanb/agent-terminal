import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import {
  installedCodexReviewerProblem,
  installedReviewerProblem,
  renderCodexReviewerAgent,
  renderReviewerAgent,
} from '../../src/main/reviewerAgents';
import { reviewerAgentFor } from '../../src/main/reviewTurn';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-flow-identity-'));
  roots.push(root);
  return root;
}

const contract = {
  loop: 'quality-loop', persona: 'check-contracts', tools: ['Read', 'Bash'], charter: 'Check the cedar contract.\n',
};

const formats = [
  {
    kind: 'claude-code' as const, extension: '.md', render: renderReviewerAgent,
    problem: installedReviewerProblem, legacy: 'quality-loop--check-contracts',
    name(text: string): string {
      const front = parseYaml(text.split('---\n')[1]) as { name: string };
      return front.name;
    },
  },
  {
    kind: 'codex' as const, extension: '.toml', render: renderCodexReviewerAgent,
    problem: installedCodexReviewerProblem, legacy: 'quality_loop__check_contracts',
    name(text: string): string { return String(parseToml(text).name); },
  },
];

for (const format of formats) {
  describe(`${format.kind} reviewer flow identity`, () => {
    it.each([
      ['cedar', 'birch'],
      ['release-flow', 'release_flow'],
      ['Release flow', 'release flow'],
      ['café', 'cafe\u0301'],
      ['品質', '品質確認'],
      ['a'.repeat(300) + 'x', 'a'.repeat(300) + 'y'],
    ])('keeps exact flow names %j and %j independent', (left, right) => {
      const a = { ...contract, flow: left };
      const b = { ...contract, flow: right };
      expect(format.name(format.render(a))).not.toBe(format.name(format.render(b)));
    });

    it.each([
      { loop: 'other-loop', persona: 'check-contracts' },
      { loop: 'quality-loop', persona: 'check-safety' },
    ])('keeps a different loop/persona independent: %j', (other) => {
      const original = { ...contract, flow: 'cedar' };
      const changed = { ...original, ...other };
      expect(format.name(format.render(original))).not.toBe(format.name(format.render(changed)));
    });

    it('uses the same identity for the same flow name regardless of charter contents', () => {
      const original = { ...contract, flow: 'cedar' };
      const revised = { ...original, charter: 'A revised cedar contract.\n' };
      expect(format.name(format.render(original))).toBe(format.name(format.render(revised)));
    });

    it('renders a bounded, platform-safe filename for a long Unicode flow name', () => {
      const spec = { ...contract, flow: '品質 Release '.repeat(100) };
      const name = format.name(format.render(spec));
      expect(name).toMatch(format.kind === 'codex' ? /^[a-z0-9_]+$/ : /^[a-z0-9_-]+$/);
      expect(Buffer.byteLength(name + format.extension)).toBeLessThanOrEqual(255);
      const root = workspace();
      expect(() => writeFileSync(join(root, name + format.extension), format.render(spec))).not.toThrow();
    });

    it('requests the installed identity for its own flow', () => {
      const a = { ...contract, flow: 'cedar' };
      const b = { ...contract, flow: 'birch' };
      const requested = reviewerAgentFor(format.kind, a);
      expect.soft(requested).toBe(format.name(format.render(a)));
      expect.soft(requested).not.toBe(format.name(format.render(b)));
    });

    it('refuses another flow even when its charter and tools match exactly', () => {
      const root = workspace();
      const agents = join(root, 'agents');
      mkdirSync(agents);
      const charter = join(root, 'charter.md');
      writeFileSync(charter, contract.charter);
      const installed = { ...contract, flow: 'cedar' };
      writeFileSync(join(agents, format.name(format.render(installed)) + format.extension), format.render(installed));
      const own = { ...installed, charter };
      const other = { ...own, flow: 'birch' };
      expect.soft(format.problem(agents, own)).toBeNull();
      expect.soft(format.problem(agents, other)).not.toBeNull();
    });

    it('does not authorize a flow from a matching legacy loop-only agent', () => {
      const root = workspace();
      const agents = join(root, 'agents');
      mkdirSync(agents);
      const charter = join(root, 'charter.md');
      writeFileSync(charter, contract.charter);
      const legacy = format.kind === 'codex'
        ? `name = "${format.legacy}"\ndescription = "The check-contracts reviewer of the quality-loop loop, installed with the agent-terminal example loops. Its instructions are its charter."\ndeveloper_instructions = '''\nYou are a reviewer. Never create, edit or delete any file: report your findings only.\n\n${contract.charter}'''\n`
        : `---\nname: ${format.legacy}\ntools: Read, Bash\n---\n${contract.charter}`;
      writeFileSync(join(agents, format.legacy + format.extension), legacy);
      const reviewer = { ...contract, flow: 'cedar', charter };
      expect(format.problem(agents, reviewer)).not.toBeNull();
    });
  });
}
