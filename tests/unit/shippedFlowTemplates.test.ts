import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { resolveFeatureDevFlowDir } from '../../src/main/exampleAssets';
import {
  loadTodoTemplateFile,
  parseTodoTemplate,
  todoTemplateFile,
  todoTemplatesDir,
} from '../../src/main/todoTemplate';

// The installer seeds the flow dir's templates and the shipped flow is what offers one as the §18.6
// picker default: a writer↔reader pair. A step binding a name with no file behind it offers a picker
// default that cannot resolve, and the install reports success either way. Every location here comes
// from the reader's own resolvers, so a change to where templates live or what they are called moves
// this test with it rather than leaving it guarding somewhere nothing looks.
const flowDir = resolveFeatureDevFlowDir({
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
      // A step may legitimately bind no template (e.g. `preparation`) — it simply offers no picker
      // default. The invariant guards steps that DO bind one: the name must resolve to a seeded, parseable file.
      if (ref === undefined) continue;
      expect(typeof ref === 'string' && ref.length > 0).toBe(true);
      expect(
        existsSync(path.join(todoTemplatesDir(flowDir), todoTemplateFile(ref!))),
      ).toBe(true);
      // Existence is not enough: the picker instantiates the file through this pair, and a template
      // whose bullets do not parse offers the operator an empty list. Read it the way the app does.
      const markdown = loadTodoTemplateFile(todoTemplatesDir(flowDir), ref!);
      expect(markdown).not.toBeNull();
      const items = parseTodoTemplate(markdown!);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.trim().length > 0)).toBe(true);
    }
  });

  it('opens the plan review by asking for the plan in business language', () => {
    const items = parseTodoTemplate(
      loadTodoTemplateFile(todoTemplatesDir(flowDir), 'plan-loop-review')!,
    );

    expect(items[0]).toBe('describe the plan to me in concise, simple, business language bullets');
  });
});
