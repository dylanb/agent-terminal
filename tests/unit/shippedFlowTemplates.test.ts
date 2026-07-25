import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

// The installer seeds example/flow/todo-templates/ and the shipped flow is what offers one as the
// §18.6 picker default: a writer↔reader pair. A step binding a name with no file behind it offers a
// picker default that cannot resolve, and the install reports success either way.
const flowDir = path.resolve(__dirname, '..', '..', 'example', 'flow');

interface ShippedFlow {
  steps?: { id?: string; todo_template?: string }[];
}

const shippedFlow = (): ShippedFlow =>
  load(readFileSync(path.join(flowDir, 'flow.yaml'), 'utf8')) as ShippedFlow;

describe('the shipped flow and the todo templates installed beside it', () => {
  it('gives every step a template the installer actually seeds', () => {
    const steps = shippedFlow().steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(
        typeof step.todo_template === 'string' && step.todo_template.length > 0,
      ).toBe(true);
      expect(
        existsSync(
          path.join(flowDir, 'todo-templates', `${step.todo_template}.md`),
        ),
      ).toBe(true);
    }
  });
});
