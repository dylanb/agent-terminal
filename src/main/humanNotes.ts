// Human-notes artifact writer (§26.6). A gate's `append-human-note` action records the human's
// request-changes/impasse reason into `.agent-loop/human-notes/{iter}.md`; the next work-agent turn's
// recipe injects it (§19.4 feedback). App-owned persistence, written wherever the spec puts it — it
// never creates or edits a .gitignore (CLAUDE.md no-gitignore-writes rule).

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Append `text` to `<repoDir>/.agent-loop/human-notes/{iteration}.md`, creating the dir/file as needed.
 *  Multiple notes in one iteration accrue (the human may request-changes more than once). */
export function writeHumanNote(repoDir: string, iteration: number, text: string): void {
  const dir = path.join(repoDir, '.agent-loop', 'human-notes');
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${iteration}.md`), `${text.trim()}\n`);
}
