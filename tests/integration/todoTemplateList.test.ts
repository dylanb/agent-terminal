import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTodoTemplates } from '../../src/main/todoTemplate';

// §4.1/§6/§21.2 — the on-demand picker lists the templates co-located with the flow.yaml under
// todo-templates/. Each entry has a `ref` (the instantiate id = filename without .md) and a
// user-understandable `name`: the template's first `# H1` heading, falling back to a humanized
// filename. Discovery runs against the real fs (no mocks); a missing dir → [].

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

  it('does not read or list a .md whose realpath escapes the templates dir (symlink guard)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tmpl-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '# Leaked secret\n\n- x\n');
      symlinkSync(join(outside, 'secret.md'), join(dir, 'evil.md')); // a symlink escaping the root
      writeFileSync(join(dir, 'ok.md'), '# OK template\n\n- y\n');
      // The escaping symlink's H1 must never be exposed (file-disclosure footgun); only the
      // in-root template is listed — mirroring loadTodoTemplateFile's realpath/within-root guard.
      expect(listTodoTemplates(dir)).toEqual([{ ref: 'ok', name: 'OK template' }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
