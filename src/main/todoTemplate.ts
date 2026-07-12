// Todo templates: a template is a markdown list parsed per §21.2.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { TodoTemplateRef } from '../shared/ipc';

/** §18.6: the templates subdir of a flow dir, and which of its files are templates. ONE definition, shared
 *  by the reader that lists them and the installer that seeds them — two copies would let the installer
 *  seed a directory, or a file extension, the reader does not look for (CLAUDE.md writer↔reader rule). */
export function todoTemplatesDir(flowDir: string): string {
  return path.join(flowDir, 'todo-templates');
}
export function isTodoTemplateFile(name: string): boolean {
  return name.endsWith('.md');
}

const TOP_LEVEL_BULLET = /^([-*+]|\d+[.)])\s+/;
const INDENTED = /^\s+\S/;
const ANY_BULLET = /^[-*+]\s+|^\d+[.)]\s+/;
const CHECKBOX = /^\[[ xX]\]\s+/;

/**
 * The VALIDATED real path of `candidate` under `root`, or null if it escapes. Callers MUST read
 * the returned real path, not the literal abs, to close the realpath→read TOCTOU window
 * (CWE-367, §20.2; mirrors readArtifact).
 */
function resolveContained(root: string, candidate: string): string | null {
  const abs = path.resolve(root, candidate);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Resolve a step's `todo_template` ref to a file inside `baseDir` (§18.6/§21.2). Callers MUST pass
 * the `todo-templates/` subdir, NOT the flow dir itself. Returns the markdown, or null for a missing
 * or `baseDir`-escaping path (never throws).
 */
export function loadTodoTemplateFile(baseDir: string, ref: string): string | null {
  const root = path.resolve(baseDir);
  const read = (candidate: string): string | null => {
    const real = resolveContained(root, candidate);
    if (real === null) return null;
    try {
      return readFileSync(real, 'utf8');
    } catch {
      return null;
    }
  };
  return read(ref) ?? (ref.endsWith('.md') ? null : read(`${ref}.md`));
}

function humanize(ref: string): string {
  const words = ref.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : ref;
}

/**
 * The todo templates in `templatesDir` for the picker (§18.6, §4.1/§6). `name` is the file's first
 * `# H1`, falling back to a humanized filename. A missing dir or read error → [] (never throws).
 */
export function listTodoTemplates(templatesDir: string): TodoTemplateRef[] {
  let files: string[];
  try {
    files = readdirSync(templatesDir);
  } catch {
    return [];
  }
  const root = path.resolve(templatesDir);
  const refs: TodoTemplateRef[] = [];
  for (const file of files.sort()) {
    if (!isTodoTemplateFile(file)) continue;
    // Skip an in-dir symlink whose real target escapes the root (§20.2).
    const real = resolveContained(root, file);
    if (real === null) continue;
    const ref = file.slice(0, -'.md'.length);
    let name = humanize(ref);
    try {
      const h1 = readFileSync(real, 'utf8').match(/^#\s+(.+?)\s*$/m);
      if (h1) name = h1[1].trim();
    } catch {
      /* unreadable file → keep the humanized fallback */
    }
    refs.push({ ref, name });
  }
  return refs;
}

/** Parse a markdown-list template into one todo text per top-level item (§21.2). */
export function parseTodoTemplate(markdown: string): string[] {
  const todos: string[] = [];
  for (const line of markdown.split('\n')) {
    if (TOP_LEVEL_BULLET.test(line)) {
      todos.push(line.replace(TOP_LEVEL_BULLET, '').replace(CHECKBOX, '').trim());
    } else if (todos.length > 0 && INDENTED.test(line)) {
      const folded = line.trim().replace(ANY_BULLET, '').replace(CHECKBOX, '').trim();
      if (folded) todos[todos.length - 1] = `${todos[todos.length - 1]} ${folded}`.trim();
    }
  }
  // Drop empties at the end, not inline: a later folded continuation can fill an item that was
  // empty when its marker was seen (§21.2 — a bare `-` must not become a blank todo).
  return todos.filter((t) => t.length > 0);
}
