import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallReviewers } from '../../src/main/installReviewers';
import { reviewerAgentName, codexReviewerAgentName } from '../../src/main/reviewerAgents';
import { flowLocations, writeFlow, writeLoopDef, writeFifo } from '../helpers/flowFixtures';

it.each(['FIFO', 'oversized'] as const)('refuses a %s reviewer destination before consent or any writes', async (kind) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-fifo-')));
  try {
    const appHome = join(root, 'app');
    const folder = flowLocations.globalCatalogEntry(appHome, 'cedar');
    const operator = join(root, 'loops');
    const configDir = join(root, 'claude');
    const codexHome = join(root, 'codex');
    mkdirSync(codexHome);
    writeFlow(folder, { name: 'cedar', steps: [{ id: 'quality', kind: 'loop', loop: 'quality-loop' }] });
    writeLoopDef(operator, 'quality-loop', { charters: ['review.md'], consolidator: 'judge.md' }, { flow: 'cedar' });
    const target = join(configDir, 'agents', `${reviewerAgentName('quality-loop', 'reviewer-1', 'cedar')}.md`);
    const other = join(codexHome, 'agents', `${codexReviewerAgentName('quality-loop', 'reviewer-1', 'cedar')}.toml`);
    if (kind === 'FIFO') writeFifo(target);
    else {
      mkdirSync(join(configDir, 'agents'), { recursive: true });
      writeFileSync(target, '');
      truncateSync(target, 32 * 1024 * 1024);
    }
    const writer = kind === 'FIFO' ? spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "operator bytes")', target], { stdio: 'ignore' }) : null;
    const exited = writer === null ? Promise.resolve() : new Promise<void>((resolve, reject) => { writer.once('exit', () => resolve()); writer.once('error', reject); });
    try {
      let output = '';
      const questions: string[] = [];
      const result = await runInstallReviewers([folder], {
        cwd: () => root, appHome, configDir, codexHome,
        loopTiers: { operator, appBundled: join(root, 'bundle'), retired: null },
        write: (text) => { output += text; },
        confirm: async (question) => { questions.push(question); return false; },
      });
      expect.soft(result).toBe(1);
      expect.soft(questions).toEqual([]);
      if (kind === 'FIFO') expect.soft(lstatSync(target).isFIFO()).toBe(true);
      else expect.soft(lstatSync(target).size).toBe(32 * 1024 * 1024);
      expect.soft(existsSync(other)).toBe(false);
      expect.soft(output).toContain(target.split('/').at(-1)!);
      expect(output).toMatch(/regular|unreadable|cannot read/i);
    } finally {
      writer?.kill('SIGKILL');
      await exited;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
