import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTodoTemplateFile } from '../../src/main/todoTemplate';

// §18.6/§21.2 — a step's `todo_template` resolves to a file CO-LOCATED with the flow.yaml that
// declared it: the ref is read relative to the flow.yaml's own directory (so a global
// ~/.agent-terminal/flow.yaml's template lives in ~/.agent-terminal/, and a repo-local one lives
// in <repo>/.agent-terminal/). A bare name resolves with a `.md` extension appended. A missing
// file and a path escaping that directory both degrade to null (never a throw). No fs mocks.

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
});
