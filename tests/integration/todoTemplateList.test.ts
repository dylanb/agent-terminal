import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTodoTemplates } from '../../src/main/todoTemplate';

// §4.1/§6/§21.2 — the picker lists co-located templates as { ref (filename without .md), name }.
// `name` is the first `# H1` heading, falling back to a humanized filename; a missing dir → [].
// Real fs, no mocks.

describe('listTodoTemplates (§4.1/§6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmpl-list-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists each .md template with its H1 as the user-facing name', () => {
    writeFileSync(join(dir, 'ticket-grooming.md'), '# Ticket grooming\n\n- a\n');
    writeFileSync(join(dir, 'pr-review.md'), '# PR review checklist\n\n- b\n');
    expect(listTodoTemplates(dir)).toEqual([
      { ref: 'pr-review', name: 'PR review checklist' },
      { ref: 'ticket-grooming', name: 'Ticket grooming' },
    ]);
  });

  it('falls back to a humanized filename when a template has no H1', () => {
    writeFileSync(join(dir, 'quick_check.md'), '- just items, no heading\n');
    expect(listTodoTemplates(dir)).toEqual([{ ref: 'quick_check', name: 'Quick check' }]);
  });

  it('ignores non-markdown files and returns [] for a missing directory', () => {
    writeFileSync(join(dir, 'notes.txt'), 'not a template');
    expect(listTodoTemplates(dir)).toEqual([]);
    expect(listTodoTemplates(join(dir, 'nope'))).toEqual([]);
  });

  it('excludes an in-dir symlink whose target escapes the templates root', () => {
    // An in-dir symlink pointing outside the root passes the lexical check; the picker must still
    // refuse it (resolve real paths, mirror loadTodoTemplateFile).
    writeFileSync(join(dir, 'normal.md'), '# Normal template\n\n- a\n');
    const outside = mkdtempSync(join(tmpdir(), 'tmpl-list-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# Leaked secret\n\n- x\n');
    try {
      symlinkSync(join(outside, 'secret.md'), join(dir, 'escape.md'));
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return; // platform without symlink permission — skip
    }
    expect(listTodoTemplates(dir)).toEqual([{ ref: 'normal', name: 'Normal template' }]);
    rmSync(outside, { recursive: true, force: true });
  });
});
