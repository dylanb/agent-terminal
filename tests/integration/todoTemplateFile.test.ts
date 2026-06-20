import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTodoTemplateFile } from '../../src/main/todoTemplate';

// §18.6/§21.2 — a step's `todo_template` resolves to a file CO-LOCATED with the flow.yaml that
// declared it: `loadTodoTemplateFile` reads the ref relative to whatever directory it is handed.
// In production the main wiring hands it the flow.yaml's `todo-templates/` subdir
// (`path.join(load.flowDir, 'todo-templates')`, src/main/index.ts); this unit drives that
// resolution contract directly against a temp dir. A bare name resolves with a `.md` extension
// appended. A missing file and a path escaping that directory both degrade to null (never a
// throw). No fs mocks.

describe('loadTodoTemplateFile (§18.6 — co-located with flow.yaml)', () => {
  let flowDir: string; // the directory that holds flow.yaml + its templates
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'todo-tmpl-'));
    flowDir = join(base, '.agent-terminal');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'ticket-grooming.md'), '- one\n- two\n');
  });
  afterEach(() => {
    rmSync(join(flowDir, '..'), { recursive: true, force: true });
  });

  it('reads a template by its exact co-located filename', () => {
    expect(loadTodoTemplateFile(flowDir, 'ticket-grooming.md')).toBe('- one\n- two\n');
  });

  it('resolves a bare name by appending .md', () => {
    expect(loadTodoTemplateFile(flowDir, 'ticket-grooming')).toBe('- one\n- two\n');
  });

  it('returns null for a missing template', () => {
    expect(loadTodoTemplateFile(flowDir, 'nope')).toBeNull();
  });

  it('refuses a path that escapes the flow directory (returns null)', () => {
    writeFileSync(join(flowDir, '..', 'outside.md'), '- leaked\n');
    expect(loadTodoTemplateFile(flowDir, '../outside.md')).toBeNull();
  });

  it('refuses a symlink whose real path escapes the flow directory (returns null)', () => {
    writeFileSync(join(flowDir, '..', 'secret.md'), '- leaked\n');
    symlinkSync(join(flowDir, '..', 'secret.md'), join(flowDir, 'link.md'));
    expect(loadTodoTemplateFile(flowDir, 'link.md')).toBeNull();
  });

  it('reads a template through a symlink that stays inside the flow directory (the validated path)', () => {
    symlinkSync(join(flowDir, 'ticket-grooming.md'), join(flowDir, 'alias.md'));
    expect(loadTodoTemplateFile(flowDir, 'alias.md')).toBe('- one\n- two\n');
  });
});
