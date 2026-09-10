// §19.1 — the running flow's current ticket has ONE source of truth: the `ticket` value under the `inputs:`
// key in the worktree's `.agent-terminal/flow-state.yaml` (the flow engine persists it there, flowState.ts).
// A turn that acts on "the ticket" reads its number from there and nowhere else, so a stale branch name, the
// open PR, or git history can never redirect a turn onto the wrong issue. This instruction is injected into
// every composed prompt by the work / consolidate / review composers, so no per-recipe copy can drift — the
// prompt's vocabulary and the on-disk shape share this one definition (CLAUDE.md shared-semantics).
export const CURRENT_TICKET_INSTRUCTION =
  'THE CURRENT TICKET — determine it ONLY from `.agent-terminal/flow-state.yaml`: the `ticket` value under the ' +
  '`inputs:` key is the current ticket number. Use that number and no other source — do NOT infer the ticket ' +
  'from the branch name, the open PR, git history, or anything else in the working tree.';
