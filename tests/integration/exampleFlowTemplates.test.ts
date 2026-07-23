import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadTodoTemplateFile, parseTodoTemplate } from '../../src/main/todoTemplate';

// The shipped example flow (§18.1) standing in for a global flow dir: flow.yaml + its todo-templates/.
const EXAMPLE_FLOW_DIR = path.resolve('example/flow');

describe('example flow plan step binds the plan-loop-review todo template (§18.6/§21.2)', () => {
  it('instantiates one active todo per top-level template item via the real instantiator path', () => {
    const doc = yaml.load(readFileSync(path.join(EXAMPLE_FLOW_DIR, 'flow.yaml'), 'utf8')) as {
      steps: Array<{ id: string; todo_template?: string }>;
    };
    const plan = doc.steps.find((s) => s.id === 'plan');
    expect(plan?.todo_template).toBe('plan-loop-review');

    // Resolve + parse via the same helpers index.ts's instantiateTemplate uses (loadTodoTemplateFile
    // against the step's flow dir's todo-templates/, then parseTodoTemplate).
    const md = loadTodoTemplateFile(path.join(EXAMPLE_FLOW_DIR, 'todo-templates'), plan!.todo_template!);
    expect(md).not.toBeNull();

    const items = parseTodoTemplate(md as string);
    expect(items).toHaveLength(7);
    expect(items[0]).toBe('describe the plan to me in concise, simple, business language bullets');
    expect(items.every((t) => t.length > 0)).toBe(true);
  });
});
