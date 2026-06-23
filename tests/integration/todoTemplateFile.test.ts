import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTodoTemplateFile } from '../../src/main/todoTemplate';

// §18.6/§21.2 — a step's `todo_template` resolves relative to its flow.yaml's own directory. A bare
// name gets `.md` appended. A missing file, or a path escaping that directory, degrades to null
// (never a throw). No fs mocks.

describe('loadTodoTemplateFile (§18.6 — co-located with flow.yaml)', () => {
  let flowDir: string;
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

  it('refuses an in-root symlink that targets a file outside the flow directory (returns null)', () => {
    // An in-flowDir symlink pointing outside it passes the lexical guard; the loader must still
    // refuse it (resolve real paths, not the literal path).
    const outside = mkdtempSync(join(tmpdir(), 'todo-tmpl-outside-'));
    writeFileSync(join(outside, 'secret.md'), '- leaked secret\n');
    try {
      symlinkSync(join(outside, 'secret.md'), join(flowDir, 'link.md'));
    } catch {
      return; // platform without symlink permission — skip
    }
    expect(loadTodoTemplateFile(flowDir, 'link.md')).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads an in-root symlink that targets an in-root file (read via the validated real path)', () => {
    // A legitimate in-root symlink must still return its target's content — regression pin for the
    // CWE-367 abs→real-path switch (mirrors readArtifact/loopDef, §20.2).
    writeFileSync(join(flowDir, 'target.md'), '- real target body\n');
    try {
      symlinkSync(join(flowDir, 'target.md'), join(flowDir, 'alias.md'));
    } catch {
      return; // platform without symlink permission — skip
    }
    expect(loadTodoTemplateFile(flowDir, 'alias.md')).toBe('- real target body\n');
  });
});
