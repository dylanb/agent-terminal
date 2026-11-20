import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export function seedResolvedLoop(root: string, name: string, charter: string, tools: string[] | 'all' = ['Read', 'Grep']): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'charter.md'), charter);
  writeFileSync(join(dir, 'work.md'), 'Write the requested artifact.\n');
  writeFileSync(join(dir, 'judge.md'), 'Judge the recorded review.\n');
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, yaml.dump({
    version: 'v2', name,
    work: { recipe: 'work.md', artifact: 'result' },
    reviewers: [{ persona: 'review-result', charter: 'charter.md', ...(tools === 'all' ? {} : { tools }) }],
    consolidator: { recipe: 'judge.md' },
    boundaries: [],
    report: { sections: ['summary', 'findings', 'disposition'] },
    gate: [{ option: 'approve' }],
    outputs: [{ id: 'result', path: 'result.md' }],
  }));
  return file;
}
