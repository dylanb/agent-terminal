// Todo templates (§21.2). A template is a markdown list: each TOP-LEVEL list item becomes one
// todo text. `[ ]`/`[x]` checkbox markers are ignored; nested sub-bullets and indented wrapped
// lines fold into their item; headings and col-0 prose are ignored (so a template can carry a
// title + instructions). This is `todoTemplate:instantiate`'s parse half — the wiring layer
// emits one `todo:add` per returned text, reusing the flat todo model (§16.3).

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { TodoTemplateRef } from '../shared/ipc';

const TOP_LEVEL_BULLET = /^([-*+]|\d+[.)])\s+/; // col-0 list marker (unordered or ordered)
const INDENTED = /^\s+\S/; // a continuation/sub-item folds into the current todo
const ANY_BULLET = /^[-*+]\s+|^\d+[.)]\s+/; // marker to strip when an indented line is itself a bullet
const CHECKBOX = /^\[[ xX]\]\s+/; // ignored task-list marker at the head of an item

/**
 * Resolve a step's `todo_template` ref to a file CO-LOCATED with the flow.yaml that declared it
 * (§18.6/§21.2): `flowDir` is the directory holding flow.yaml, and the ref is read relative to it
 * — so a global ~/.agent-terminal/flow.yaml's template lives in ~/.agent-terminal/, a repo-local
 * one in <repo>/.agent-terminal/. A bare name resolves with `.md` appended. Returns the markdown
 * or null; a missing file or a path escaping `flowDir` both degrade to null (never a throw),
 * mirroring readArtifact's escape guard (§20.2).
 */
export function loadTodoTemplateFile(flowDir: string, ref: string): string | null {
  const root = path.resolve(flowDir);
  const read = (candidate: string): string | null => {
    const abs = path.resolve(root, candidate);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null; // lexical escape guard
    try {
      const real = realpathSync(abs);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null; // symlink escape
      return readFileSync(real, 'utf8'); // read the validated real path, not abs (TOCTOU; mirrors readArtifact)
    } catch {
      return null;
    }
  };
  // Exact ref first, then a `.md`-appended bare name (templates are markdown lists, §21.2).
  return read(ref) ?? (ref.endsWith('.md') ? null : read(`${ref}.md`));
}

/** A bare ref → a readable label: `-`/`_` become spaces, first letter capitalized. */
function humanize(ref: string): string {
  const words = ref.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : ref;
}

/**
 * List the todo templates in `templatesDir` (`<flowDir>/todo-templates/`, §18.6) for the on-demand
 * picker (§4.1/§6). Each `*.md` yields `{ ref, name }`: `ref` = filename minus `.md`, `name` = the
 * file's first `# H1` heading, falling back to a humanized filename. Sorted by ref; a missing dir
 * (or read error) → [] (never a throw).
 */
export function listTodoTemplates(templatesDir: string): TodoTemplateRef[] {
  const root = path.resolve(templatesDir);
  let files: string[];
  let realRoot: string;
  try {
    files = readdirSync(root);
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const refs: TodoTemplateRef[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    // Skip any entry whose realpath escapes the templates dir: a symlink could point outside the
    // repo and leak its H1 (file disclosure) — mirrors loadTodoTemplateFile's within-root guard.
    let real: string;
    try {
      real = realpathSync(path.join(root, file));
    } catch {
      continue; // broken/unreadable link → not a listable template
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
    const ref = file.slice(0, -'.md'.length);
    let name = humanize(ref);
    try {
      const h1 = readFileSync(real, 'utf8').match(/^#\s+(.+?)\s*$/m); // read the validated real path
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
      // Fold a sub-bullet or wrapped continuation into the current item; drop a nested marker.
      const folded = line.trim().replace(ANY_BULLET, '').replace(CHECKBOX, '').trim();
      if (folded) todos[todos.length - 1] = `${todos[todos.length - 1]} ${folded}`.trim();
    }
    // Headings, blank lines, and col-0 prose are ignored (they neither start nor extend a todo).
  }
  return todos;
}
