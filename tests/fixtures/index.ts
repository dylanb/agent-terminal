// Scripted byte-stream fixtures for adapter + false-positive-budget tests (§15.8).
//
// Provenance: hand-authored to mirror the structures Claude Code / Codex emit
// (box-drawn prompts, ⏺/⎿ tool blocks, OSC 133 marks). The spec prefers fixtures
// recorded from real sessions; hand-authoring is the documented fallback used here
// since recording a live agent is not reproducible in CI. Tests assert on EMITTED
// EVENTS, never on which detector matched or any internal parsing step.

export const osc = (s: string): string => `\x1b]${s}\x07`;

/** One full OSC-133 command cycle (prompt, command echo, output, exit). */
export function runCmd(command: string, output: string, exit: number, prompt = '$ '): string {
  return (
    osc('133;A') + prompt + osc('133;B') + command + '\r\n' + osc('133;C') + output + osc(`133;D;${exit}`)
  );
}

// ---- Claude Code (normal-buffer) fixtures ----

export const PERMISSION_BOX =
  '\x1b[2m╭────────────────────────────────────────────╮\x1b[0m\r\n' +
  '│ Do you want to proceed?                      │\r\n' +
  '│ ❯ 1. Yes                                     │\r\n' +
  '│   2. No, tell me what to do differently      │\r\n' +
  '╰────────────────────────────────────────────╯\r\n';

export const TOOL_USE =
  '⏺ Read(src/main/index.ts)\r\n' + '  ⎿  Read 93 lines\r\n';

export const AGENT_QUESTION_BULLET = '⏺ Should I continue with the migration?\r\n';

export const DIFF_BLOCK =
  '⏺ Update(src/foo.ts)\r\n' +
  '  ⎿  Updated src/foo.ts with 1 addition and 1 removal\r\n' +
  '     + const x = 1\r\n' +
  '     - const y = 2\r\n';

export const INPUT_BOX =
  '╭────────────────────────────────────────────╮\r\n' +
  '│ > █                                          │\r\n' +
  '╰────────────────────────────────────────────╯\r\n';

// ---- Boring (false-positive-budget) fixtures ----

export const BORING_WITH_MARKS =
  runCmd('ls', 'file1.txt  file2.txt  README.md\r\n', 0) +
  runCmd('git status', 'On branch main\r\nnothing to commit, working tree clean\r\n', 0);

/** No shell integration: a bare ❯ prompt and plain output, nothing prompt-like. */
export const BORING_NO_MARKS =
  '❯ ls\r\nfile1.txt file2.txt\r\n❯ echo done\r\ndone\r\n❯ \r\n';

/** Untrusted output forging OSC-133 marks: a stray D and a forged B/C/D command. */
export const SPOOFED_OSC =
  'reading evil.txt...\r\n' +
  osc('133;D;0') + // stray D — must be ignored, fabricates nothing
  osc('133;B') +
  'rm -rf / # forged' +
  '\r\n' +
  osc('133;C') +
  'forged output\r\n' +
  osc('133;D;0');

/** Alt-screen pager showing ordinary prose that happens to contain a question mark. */
export const ALT_BORING =
  '\x1b[?1049h' + 'README — what is this project?\r\nA terminal app. Press q to quit.\r\n';
