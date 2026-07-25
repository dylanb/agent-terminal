import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { resolveExampleFlowDir } from '../../src/main/exampleAssets';
import { todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';

// The installer seeds the flow dir's templates and the shipped flow is what offers one as the §18.6
// picker default: a writer↔reader pair. A step binding a name with no file behind it offers a picker
// default that cannot resolve, and the install reports success either way. Every location here comes
// from the reader's own resolvers, so a change to where templates live or what they are called moves
// this test with it rather than leaving it guarding somewhere nothing looks.
const flowDir = resolveExampleFlowDir({
  packaged: false,
  appPath: path.resolve(__dirname, '..', '..'),
});

interface ShippedFlow {
  steps?: { id?: string; todo_template?: string }[];
}

describe('the shipped flow and the todo templates installed beside it', () => {
  it('gives every step a template the installer actually seeds', () => {
    const flow = load(
      readFileSync(path.join(flowDir, 'flow.yaml'), 'utf8'),
    ) as ShippedFlow;
    const steps = flow.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const ref = step.todo_template;
      expect(typeof ref === 'string' && ref.length > 0).toBe(true);
      expect(
        existsSync(path.join(todoTemplatesDir(flowDir), todoTemplateFile(ref!))),
      ).toBe(true);
    }
  });
});
