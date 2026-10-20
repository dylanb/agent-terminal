// Fake tools shared by the e2e specs (one spec never imports another, or Playwright registers its tests
// twice): the PATH-first fake `gh`/`git` shims, the scriptable fake agent, and the config/catalog seeds.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport, type ReviewerStatus } from '../../src/shared/roundReport';
import { exampleConsolidatorOutput, type ConsolidatorVerdict } from '../../src/shared/consolidatorOutput';
import { PHASE_OUTPUT_SUFFIX, exampleCapturedOutput, examplePhaseResult } from '../../src/shared/phaseResult';
import { exampleSlicePlan } from '../../src/shared/slicePlan';
import { shellQuote } from '../../src/shared/shellQuote';
import type { PhaseOutcome } from '../../src/shared/phaseOutcome';
import type { BuildOutcome } from '../../src/shared/buildOutcome';
import { catalogEntryDefFile } from '../../src/main/flow';
import { FEATURE_DEV_ID, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { roundReportWithDisposition, roundReportWithStatuses } from '../helpers/roundReports';
import { seedSharedExampleConfig } from '../helpers/e2eExampleConfig';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { verdictOutput } from '../helpers/consolidatorOutputs';

export const exampleConfigDir = seedSharedExampleConfig();

// The bound on every shim hold, well below the 60 s test ceiling, so a hold nobody releases fails its test on
// that test's own assertion. Logs `held <pid> <argv>` first, then `released <pid>`, or `expired <pid>` and
// fails the call.
const HOLD_WAIT_FN =
  'hold_wait() { echo "held $$ $2" >> "$FAKE_GHGIT_LOG"; end=$((SECONDS + 30)); while [ -e "$1" ]; do if [ "$SECONDS" -ge "$end" ]; then echo "expired $$" >> "$FAKE_GHGIT_LOG"; return 1; fi; sleep 0.05; done; echo "released $$" >> "$FAKE_GHGIT_LOG"; }\n';

// The §27 bootstrap shells real git/gh. e2e prepends a fake gh + git on PATH that record their argv
// and emit canned output (no network/auth/remote), so the run is deterministic on a real PTY: the PTY
// + shell are real, only the bootstrap helpers are stubbed.
// Returns the bin dir to prepend to PATH and the log file the fakes append every invocation to.
export function seedFakeGhGit(prefix: string, opts: { realCommitOps?: boolean } = {}): { binDir: string; logFile: string } {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  const logFile = join(binDir, 'calls.log');
  // Resolve REAL git once from the test process (whose PATH lacks binDir, so this is never the shim) rather
  // than hard-coding a path — keeps the shim-escape without coupling to the container base image's git location.
  const realGit = opts.realCommitOps
    ? execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    : '';
  const fakeGit =
    '#!/usr/bin/env bash\n' +
    HOLD_WAIT_FN +
    // FAKE_GIT_HOLD_REV/FAKE_GIT_HOLD: while the hold file exists, hold every invocation in which some argv element
    // contains the rev, logging `held <pid> <argv>` first and `released <pid>` (or `expired <pid>`, exit 1) after.
    // With FAKE_GIT_HOLD_REV unset, the rev is the hold file's first line, for a rev known only mid-run.
    'hold_rev="$FAKE_GIT_HOLD_REV"; if [ -z "$hold_rev" ] && [ -n "$FAKE_GIT_HOLD" ] && [ -s "$FAKE_GIT_HOLD" ]; then hold_rev=$(head -n 1 "$FAKE_GIT_HOLD"); fi\n' +
    'if [ -n "$hold_rev" ] && [ -n "$FAKE_GIT_HOLD" ] && [ -e "$FAKE_GIT_HOLD" ]; then for a in "$@"; do case "$a" in *"$hold_rev"*) hold_wait "$FAKE_GIT_HOLD" "git $*" || exit 1; break;; esac; done; fi\n' +
    // Skip ALL leading git GLOBAL options so `$1` is the subcommand real git would dispatch: the bootstrap
    // port's throwaway `--git-dir <tmp>`, the neutralizing `-c <k=v>` pairs, and `--no-replace-objects` (the §28
    // reads' tamper-evidence flag — workingTreeTestPaths/changedTestPaths/baselineCapabilities send it ahead of
    // the -c pairs). A case-loop handles them in any order, so a new global flag on a delegated read is skipped.
    'while :; do case "$1" in --git-dir) shift 2;; -c) shift 2;; --no-replace-objects) shift;; *) break;; esac; done\n' +
    // §28.3 — the `commit` side-effect's porcelain ops delegate to REAL git so HEAD genuinely advances in the
    // repo, while every bootstrap/remote op below stays canned. These subcommands are never used by the drive.
    // §28.5.1/§28.5.3 delegates the commit side-effect's real ops to real git: add/reset/commit, rev-list (the
    // baseline sha+parent capture), ls-files (the working-tree RED test detection + the GREEN frozen check's
    // untracked arm, filter-free), diff (workingTreeTestPaths' --numstat arm AND the GREEN frozen check's
    // baseline↔working-tree name-only arm), and ls-tree/cat-file (the GREEN frozen check's baselineCapabilities
    // reads the committed loop-capabilities.yaml as a blob). rev-parse is delegated ONLY for the object-resolve
    // form `--verify --end-of-options <rev>` (4 args): the pre-commit HEAD the parent-linkage guard compares
    // against AND the baseline `<sha>^{commit}` resolve baselineCapabilities does — the canned bootstrap/flow
    // rev-parse arms below (and the plain `rev-parse HEAD` the drive uses) never take that form, so they keep
    // their scripted answer; a blanket rev-parse delegation breaks the drive (the loop never starts).
    (opts.realCommitOps ? `case "$1" in add|reset|commit|diff|rev-list|ls-files|ls-tree|cat-file) exec ${realGit} "$@";; esac\n` : '') +
    (opts.realCommitOps ? `if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "--end-of-options" ] && [ "$#" -eq 4 ]; then exec ${realGit} "$@"; fi\n` : '') +
    // §28.5.1 — the frozen baseline's branch key: `rev-parse --abbrev-ref HEAD` (commit adapter's capture +
    // the engine's currentGitBranch) delegates to real git so both read the REAL branch; delegated by its EXACT
    // form only, so every canned bootstrap/flow-detection rev-parse arm below keeps its scripted answer.
    (opts.realCommitOps ? `if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ] && [ "$3" = "HEAD" ] && [ "$#" -eq 3 ]; then exec ${realGit} "$@"; fi\n` : '') +
    'echo "git $*" >> "$FAKE_GHGIT_LOG"\n' +
    // status --porcelain emits nothing → a clean tree; when FAKE_GIT_DIRTY is set it emits a non-.agent-loop
    // porcelain line → a dirty tree, so the bootstrap's clean-tree gate aborts. Every other op is a recorded no-op success.
    'if [ "$1" = "status" ] && [ -n "$FAKE_GIT_DIRTY" ]; then echo " M src/app.ts"; exit 0; fi\n' +
    'if [ "$1" = "status" ] && [ "$2" = "--porcelain" ] && [ "$#" -eq 2 ] && [ -n "$FAKE_GIT_DIRTY_ONCE" ] && [ ! -e "$FAKE_GHGIT_LOG.dirty-seen" ]; then touch "$FAKE_GHGIT_LOG.dirty-seen"; echo " M src/app.ts"; exit 0; fi\n' +
    // branch --list prints the queried branch when FAKE_GIT_BRANCH_EXISTS is set → a bootstrap branch conflict.
    'if [ "$1" = "branch" ] && [ "$2" = "--list" ]; then local_branch=$(cat "$FAKE_GHGIT_LOG.local-branch" 2>/dev/null || true); if [ -n "$FAKE_GIT_BRANCH_EXISTS" ] || [ "$local_branch" = "$3" ]; then echo "  $3"; fi; exit 0; fi\n' +
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo "https://github.com/fake/repo.git"; exit 0; fi\n' +
    // show-ref --verify is the local half of the §27.10 conflict probe: exit 1 (not 128) when the ref is
    // absent, which is what the port distinguishes "no local branch" from "the probe itself failed" by.
    'if [ "$1" = "show-ref" ]; then ref=${!#}; local_branch=$(cat "$FAKE_GHGIT_LOG.local-branch" 2>/dev/null || true); if [ "$local_branch" = "${ref#refs/heads/}" ]; then exit 0; fi; exit 1; fi\n' +
    'if [ "$1" = "symbolic-ref" ]; then cat "$FAKE_GHGIT_LOG.current-branch" 2>/dev/null || echo main; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ] && [ "$3" = "HEAD" ] && [ "$#" -eq 3 ]; then if [ -f "$FAKE_GHGIT_LOG.current-branch" ]; then cat "$FAKE_GHGIT_LOG.current-branch"; else head=$(cat .git/HEAD 2>/dev/null || true); case "$head" in "ref: refs/heads/"*) echo "${head#ref: refs/heads/}";; "") echo main;; *) echo HEAD;; esac; fi; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then pwd -P; exit 0; fi\n' +
    // Origin is read from config, never `remote get-url` (which applies url.*.insteadOf). Real git exits 1
    // for an unset key, which is how the port tells "no separate push URL" from a broken config.
    'if [ "$1" = "config" ] && { [ "$2" = "--get" ] || [ "$2" = "--get-all" ]; }; then case "$3" in remote.origin.url) echo "https://github.com/fake/repo.git"; exit 0;; remote.origin.pushurl) exit 1;; esac; fi\n' +
    'if [ "$1" = "init" ]; then exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then mkdir -p "$FAKE_GHGIT_LOG.objects"; echo "$FAKE_GHGIT_LOG.objects"; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-object-format" ]; then echo sha1; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "FETCH_HEAD" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "fetch" ]; then exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "commit-tree" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ] && [ "$2" = "--create-reflog" ]; then echo "${5#refs/heads/}" > "$FAKE_GHGIT_LOG.local-branch"; echo "$6" > "$FAKE_GHGIT_LOG.local-oid"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ]; then case "$2" in refs/heads/*) echo "${2#refs/heads/}" > "$FAKE_GHGIT_LOG.local-branch"; echo "$3" > "$FAKE_GHGIT_LOG.local-oid"; exit 0;; esac; fi\n' +
    // The wipe deletes the local branch with the PORCELAIN `git branch -D` (only it knows git's full
    // "branch is in use" rule), and reads back the object it removed to re-establish the lease.
    // Upstream is configured as the pair `git push -u` writes, not via --set-upstream-to, which resolves
    // through the remote's fetch refspec and refuses on a single-branch clone.
    'if [ "$1" = "config" ]; then case "$2" in branch.*.remote|branch.*.merge) echo "$2=$3" >> "$FAKE_GHGIT_LOG.upstream"; exit 0;; esac; fi\n' +
    'if [ "$1" = "branch" ] && [ "$2" = "-D" ]; then name=${!#}; rm -f "$FAKE_GHGIT_LOG.local-branch" "$FAKE_GHGIT_LOG.local-oid"; echo "Deleted branch $name (was 1111111111111111111111111111111111111111)."; exit 0; fi\n' +
    'if [ "$1" = "branch" ] && [ "$3" = "FETCH_HEAD" ]; then echo "$2" > "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "branch" ]; then case "$2" in --set-upstream-to=*) echo "${2#--set-upstream-to=}" > "$FAKE_GHGIT_LOG.upstream"; exit 0;; esac; fi\n' +
    'if [ "$1" = "checkout" ] && [ "$2" != "--detach" ]; then echo "$2" > "$FAKE_GHGIT_LOG.current-branch"; exit 0; fi\n' +
    'if [ "$1" = "branch" ] && [ "$2" = "-D" ]; then rm -f "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ] && [ "$2" = "-d" ]; then rm -f "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "push" ]; then for arg in "$@"; do case "$arg" in [0-9a-f]*:refs/heads/*) branch=${arg##*:refs/heads/}; oid=${arg%%:*}; echo "$branch" > "$FAKE_GHGIT_LOG.remote-branch"; echo "$oid" > "$FAKE_GHGIT_LOG.remote-oid"; exit 0;; esac; done; fi\n' +
    'if [ "$1" = "ls-remote" ]; then branch=${!#}; branch=${branch#refs/heads/}; remote_branch=$(cat "$FAKE_GHGIT_LOG.remote-branch" 2>/dev/null || true); if [ "$remote_branch" = "$branch" ]; then printf "%s\\t%s\\n" 1111111111111111111111111111111111111111 "refs/heads/$branch"; fi; exit 0; fi\n' +
    'if [ "$1" = "push" ]; then delete_next=; for arg in "$@"; do if [ -n "$delete_next" ]; then rm -f "$FAKE_GHGIT_LOG.remote-branch"; exit 0; fi; [ "$arg" = "--delete" ] && delete_next=1; done; fi\n' +
    'if [ "$1" = "push" ]; then for arg in "$@"; do case "$arg" in :refs/heads/*) rm -f "$FAKE_GHGIT_LOG.remote-branch" "$FAKE_GHGIT_LOG.remote-oid"; exit 0;; esac; done; fi\n' +
    'exit 0\n';
  const fakeGh =
    '#!/usr/bin/env bash\n' +
    HOLD_WAIT_FN +
    'echo "gh $*" >> "$FAKE_GHGIT_LOG"\n' +
    // The approve side-effect action a `gh` invocation performs (src/main/appGateGithub.ts builds these argv);
    // FAKE_GH_HOLD/FAKE_GH_HOLD_ACTION hold only that action's call and FAKE_GH_FAIL_ACTION fails only it, so the
    // bootstrap, ref lookups and `gh pr view` stay unheld.
    'gh_action() { case "$1 $2" in "pr ready") echo mark-ready;; "issue edit") case " $* " in *" --body-file "*) echo update-issue-body;; esac;; "pr edit") case " $* " in *" --body-file "*) echo publish-pr-body;; esac;; esac; }\n' +
    'action=$(gh_action "$@")\n' +
    'if [ -n "$action" ] && [ -n "$FAKE_GH_HOLD" ] && [ "$action" = "$FAKE_GH_HOLD_ACTION" ] && [ -e "$FAKE_GH_HOLD" ]; then hold_wait "$FAKE_GH_HOLD" "gh $*" || exit 1; fi\n' +
    'if [ -n "$action" ] && [ "$action" = "$FAKE_GH_FAIL_ACTION" ]; then echo "fake gh: injected failure for $action" >&2; exit 1; fi\n' +
    'if [ "$1" = "repo" ] && [ "$2" = "view" ] && [[ "$*" = *nameWithOwner* ]]; then echo \'{"nameWithOwner":"fake/repo","url":"https://github.com/fake/repo","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "main"; exit 0; fi\n' +
    // seedServedTicket's knob; BEFORE the §28.7 body-read arm, which would otherwise shadow the served issue.
    'if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ -n "$FAKE_GH_ISSUE_JSON" ] && [ "$3" = "$FAKE_GH_ISSUE_NUM" ]; then filter=; prev=; for arg in "$@"; do case "$prev" in -q|--jq) filter=$arg;; esac; case "$arg" in -q=*|--jq=*) filter=${arg#*=};; esac; prev=$arg; done; case "$filter" in "") cat "$FAKE_GH_ISSUE_JSON";; .body) cat "$FAKE_GH_ISSUE_BODY";; ".labels[].name") cat "$FAKE_GH_ISSUE_LABELS";; *) echo "fake gh: no served-ticket answer for filter $filter" >&2; exit 1;; esac; exit $?; fi\n' +
    // §28.7 — the epic body read for the tracking-issue append; BEFORE the greedy `issue view` arm so it is not
    // shadowed. Returns a fixed non-empty original body so the append preserves it as a prefix.
    'if [ "$1" = "issue" ] && [ "$2" = "view" ] && [[ "$*" = *"--json body"* ]]; then printf \'%s\\n\' "Original epic intent — do not overwrite."; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then echo \'{"title":"Fake ticket","url":"https://github.com/fake/repo/issues/176"}\'; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then state=OPEN; [ -e "$FAKE_GHGIT_LOG.pr-$3-closed" ] && state=CLOSED; head_oid=5555555555555555555555555555555555555555; [ "$3" = "321" ] && head_oid=2222222222222222222222222222222222222222; closing_url=https://github.com/fake/repo/issues/176; [ -n "$FAKE_CLOSING_ISSUE_OTHER_REPO" ] && closing_url=https://github.com/other/repo/issues/176; printf \'{"number":%s,"url":"https://github.com/fake/repo/pull/%s","headRefName":"plan-loop/issue-176","headRefOid":"%s","state":"%s","closingIssuesReferences":[{"number":176,"url":"%s"}],"isCrossRepository":false,"headRepository":{"name":"Repo"},"headRepositoryOwner":{"login":"Fake"}}\\n\' "$3" "$3" "$head_oid" "$state" "$closing_url"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then if [ -n "$FAKE_GIT_BRANCH_EXISTS" ] && [ ! -e "$FAKE_GHGIT_LOG.pr-321-closed" ]; then echo \'[{"number":321,"url":"https://github.com/fake/repo/pull/321","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"Repo"},"headRepositoryOwner":{"login":"Fake"}},{"number":999,"url":"https://github.com/contributor/fork/pull/999","headRefOid":"9999999999999999999999999999999999999999","isCrossRepository":true,"headRepository":{"name":"fork"},"headRepositoryOwner":{"login":"contributor"}}]\'; else echo \'[]\'; fi; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "close" ]; then touch "$FAKE_GHGIT_LOG.pr-$3-closed"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "edit" ] && [ "$4" = "--body-file" ] && [ "$5" = "-" ]; then cat > "$FAKE_GHGIT_LOG.pr-body"; exit 0; fi\n' +
    // §28.7 — the epic-body edit (the tracking append) captures its stdin per-issue so each written body is
    // independently assertable ($3 is the issue number).
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ] && [ "$4" = "--body-file" ] && [ "$5" = "-" ]; then cat > "$FAKE_GHGIT_LOG.issue-body.$3"; exit 0; fi\n' +
    // §28.7 — each `gh issue create` returns a fresh issue URL (a per-binDir counter seeded at 500) so the
    // sub-tickets carry distinct numbers, and CAPTURES its stdin body per-issue so each sub-ticket body is
    // independently assertable (the create must consume stdin or the caller's --body-file - write blocks).
    'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then seq="$FAKE_GHGIT_LOG.issue-seq"; n=$(cat "$seq" 2>/dev/null || echo 500); n=$((n+1)); echo "$n" > "$seq"; cat > "$FAKE_GHGIT_LOG.issue-body.$n"; echo "https://github.com/fake/repo/issues/$n"; exit 0; fi\n' +
    // §28.7 — the repo's labels live one per line in a sink: `label list` reports them, `label create` adds one
    // (or fails under FAKE_GH_LABEL_CREATE_FAIL), and under FAKE_GH_STRICT_LABELS an `--add-label` of an
    // agent-loop/* label the repo lacks fails as real GitHub does.
    'if [ "$1" = "label" ] && [ "$2" = "list" ]; then out="["; sep=""; while IFS= read -r l; do out="$out$sep{\\"name\\":\\"$l\\"}"; sep=","; done < <(cat "$FAKE_GHGIT_LOG.labels" 2>/dev/null); echo "$out]"; exit 0; fi\n' +
    'if [ "$1" = "label" ] && [ "$2" = "create" ]; then if [ -n "$FAKE_GH_LABEL_CREATE_FAIL" ]; then echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi; echo "$3" >> "$FAKE_GHGIT_LOG.labels"; exit 0; fi\n' +
    'if [ -n "$FAKE_GH_STRICT_LABELS" ] && [ "$1" = "issue" ] && [ "$2" = "edit" ] && [ "$4" = "--add-label" ] && [[ "$5" = agent-loop/* ]] && ! grep -qxF "$5" "$FAKE_GHGIT_LOG.labels" 2>/dev/null; then echo "could not add label: \'$5\' not found" >&2; exit 1; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ] && [ "$4" = "--add-assignee" ]; then echo "$3:$5" > "$FAKE_GHGIT_LOG.issue-assignee"; exit 0; fi\n' +
    // Label edits: keep the single last-write sink (the pickup tests read it) AND append per-issue so every
    // sub-ticket's label set is independently assertable.
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.issue-label"; echo "$value" >> "$FAKE_GHGIT_LOG.issue-label.$3"; exit 0; fi\n' +
    // The `pr create` call is logged BEFORE an optional FAKE_PICKUP_DELAY sleep, so a test can hold the
    // bootstrap mid-flight (the branch is created, app state not yet written) long enough to terminate the
    // flow and prove the async completion drops as stale.
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then [ -n "$FAKE_PICKUP_DELAY" ] && sleep "$FAKE_PICKUP_DELAY"; [ -n "$FAKE_PR_CREATE_FAIL" ] && exit 1; echo 4242 > "$FAKE_GHGIT_LOG.pr-created"; echo "https://github.com/fake/repo/pull/4242"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.pr-label"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then echo "$3" > "$FAKE_GHGIT_LOG.pr-ready"; exit 0; fi\n' +
    // CI run-don't-block — `gh pr checks` returns the current bucket state (one pending, one pass)
    // and exits non-zero (8) as real gh does when checks are pending; the app parses stdout regardless and
    // never waits. The invocation is logged (above) BEFORE the optional FAKE_GH_CHECKS_DELAY sleep, so a
    // test can hold the snapshot's RESULT back to prove the loop reaches its gate before the snapshot lands.
    'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then [ -n "$FAKE_GH_CHECKS_DELAY" ] && sleep "$FAKE_GH_CHECKS_DELAY"; echo \'[{"bucket":"pass"},{"bucket":"pending"}]\'; exit 8; fi\n' +
    'exit 0\n';
  writeFileSync(join(binDir, 'git'), fakeGit, { mode: 0o755 });
  writeFileSync(join(binDir, 'gh'), fakeGh, { mode: 0o755 });
  return { binDir, logFile };
}

// The plan-loop (§27) reviewer catalog + report structure the committed example def declares — the roster
// the round report must account for and the sections it must carry (example/loops-v2/plan-only/plan-loop/plan-loop.yaml).
export const PLAN_V2_ROSTER = [
  'review-plan-principal',
  'review-plan-security',
  'review-plan-architecture',
  'review-plan-intent',
  'review-plan-maintainability',
  'review-plan-contracts',
];
export const PLAN_V2_SECTIONS = ['summary', 'findings', 'disposition'];
export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
/** Shell that writes a §28.5.5 phase result at `pathExpr` and its raw captured run beside it, where the engine reads
 *  it. */
export const writePhaseResultSh = (pathExpr: string, result: string, captured = exampleCapturedOutput('passed')): string =>
  `rp=${pathExpr}; mkdir -p "$(dirname "$rp")"; printf %s '${b64(result)}' | base64 -d > "$rp"; printf %s '${b64(captured)}' | base64 -d > "\${rp%.*}${PHASE_OUTPUT_SUFFIX}"`;
// A well-formed report that records the FIRST roster persona as FAILED TO RUN (§27.5/AC7) — the signal the
// consolidator clean-guard keys on.
const firstMarkedReport = (sections: string[], roster: string[], status: ReviewerStatus): string =>
  roundReportWithStatuses(sections, roster, roster.length > 0 ? { [roster[0]]: status } : {});
const failedReport = (sections: string[], roster: string[]): string => firstMarkedReport(sections, roster, 'failed');

export type FakeWorkMode = 'complete' | 'no-marker' | 'file-only' | 'noop' | 'red' | 'green' | 'refactor' | 'ask';
export type FakeReviewMode = 'full' | 'omit-persona' | 'none' | 'failed' | 'omit-then-repair' | 'not-loaded';

// One step's script for the fake agent (§27.15 test seam).
//   work:  complete — marker-bearing artifact + done-file → the work turn completes and chains review.
//          no-marker — artifact WITHOUT the marker + done-file → one work retry then error (no chain).
//          file-only — marker-bearing artifact but NO done-file → work stall→error with the artifact present.
//          noop — produce nothing; the turn never completes (only for a turn that must be stranded).
//          ask — ask the operator a question and wait silently; the operator's `yes` completes the turn.
//   review: full — a report accounting for the whole roster → the review turn completes (default).
//           omit-persona — a report dropping a roster persona → one review retry then error.
//           none — write nothing on the review turn → review stall/retry→error.
export interface StepScript {
  artifactRel: string;
  work: FakeWorkMode;
  // Holds every work turn of this step while the `sentinel` file exists. The held turn runs in the background
  // (the agent keeps reading its input) and first appends its pid to `<sentinel>.pids`; then, polled every
  // 50 ms: `<sentinel>.abandon` present → exits with no action; the sentinel gone → does the `work` action;
  // 30 s elapsed → exits with no action, so an unreleased hold fails its test on that test's own assertion.
  hold?: { sentinel: string };
  // Holds every consolidate turn of this step the same way, with its own sentinel.
  holdConsolidate?: { sentinel: string };
  // The review roster/sections the step's loop declares (default: the plan-loop's).
  roster?: string[];
  sections?: string[];
  // §28.5.5 — the classified outcome the fake writes into the phase-result file, read back by every
  // result-producing work mode's completion gate (red/green/refactor). `writeTest` is RED-only: whether the
  // turn authors a test-glob file this turn (the "a test was added" async clause).
  resultOutcome?: PhaseOutcome;
  writeTest?: boolean;
  // §28.5.3 GREEN work mode: the build classification written alongside `resultOutcome` (default 'built'), and
  // whether the turn MODIFIES a committed test-glob file (`touchTest`, the frozen-check detection) vs a non-test
  // file. `resultOutcome` defaults to 'passed'.
  buildOutcome?: BuildOutcome;
  touchTest?: boolean;
  // §28.5.3 GREEN work mode: whether the review-and-fix round (not the work turn) modifies the committed
  // test-glob file.
  reviewTouchesTest?: boolean;
  // Round-1 review report kind; `omit-then-repair` writes the omitting report first and the full report on the
  // §27.12 repair prompt.
  review?: FakeReviewMode;
  // Round-2 review report kind, default `full`.
  review2?: 'full' | 'failed';
  // Per-round override of the report kind (index = round-1): `needs-human` records the first persona's issue
  // with the `needs a human` disposition.
  reviews?: ('full' | 'needs-human')[];
  // The consolidator output per round (index = round-1), each the FULL verdict file content. Absent → every
  // round emits `verdict: clean`.
  verdicts?: string[];
  // The consolidator output per consolidate ATTEMPT of this step (index = attempt-1), counted across retries,
  // which the round-keyed `verdicts` cannot tell apart. Takes precedence over `verdicts` where present.
  consolidateAttempts?: string[];
  // Shell run before the done-signal of this step's n-th turn of each kind (index = n-1).
  extraShell?: { work?: string[]; review?: string[]; consolidate?: string[] };
  logInjected?: boolean;
}

const turnCountFn = (binDir: string): string => {
  const counts = shellQuote(join(binDir, 'turn-counts'));
  return `turn_count() { mkdir -p ${counts}; f=${counts}/"$1"; c=$(cat "$f" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" > "$f"; printf %s "$c"; }\n`;
};
const DONE_REL = `.agent-terminal/loop/${TURN_DONE_FILENAME}`;
const HOLD_CAP_S = 30;
const doneSignal = (key: string): string => `mkdir -p .agent-terminal/loop; printf '%s' '${key}' > ${DONE_REL}`;
const byTurn = (counter: string, entries: string[] | undefined): string =>
  entries && entries.length > 0 ? `case "$${counter}" in ${entries.map((e, i) => `${i + 1}) ${e} ;;`).join(' ')} esac` : ':';

/** Runs `action` in the background once `sentinel` is deleted (see `StepScript.hold`), so the agent keeps reading. */
function heldAction(sentinelPath: string, action: string): string {
  const sentinel = shellQuote(sentinelPath);
  const abandon = shellQuote(`${sentinelPath}.abandon`);
  const pids = shellQuote(`${sentinelPath}.pids`);
  return (
    `( pid=$(exec sh -c 'echo $PPID'); printf '%s\\n' "$pid" >> ${pids}; ` +
    `end=$((SECONDS + ${HOLD_CAP_S})); while :; do ` +
    `if [ -e ${abandon} ]; then exit 0; fi; ` +
    `if [ ! -e ${sentinel} ]; then [ -e ${abandon} ] && exit 0; ${action}; exit 0; fi; ` +
    `if [ "$SECONDS" -ge "$end" ]; then exit 0; fi; sleep 0.05; done ) </dev/null &`
  );
}

function stepArms(stepId: string, opts: StepScript): string[] {
  const turnKey = `work-${stepId}`;
  const reviewKey = `review-${stepId}`;
  const consolidateKey = `consolidate-${stepId}`;
  const roster = opts.roster ?? PLAN_V2_ROSTER;
  const sections = opts.sections ?? PLAN_V2_SECTIONS;
  const count = (key: string, v: string): string => `${v}=$(turn_count ${shellQuote(key)})`;
  const marker = completionMarker(stepId);
  const writeArtifact = (withMarker: boolean): string =>
    `mkdir -p "$(dirname ${opts.artifactRel})"; ` +
    (withMarker
      ? `printf '%s\\n' '# plan' '${marker}' > ${opts.artifactRel}`
      : `printf '%s\\n' '# plan' 'no marker here' > ${opts.artifactRel}`);
  const bump = 'mkdir -p .agent-terminal; printf x >> .agent-terminal/work-runs';
  // §28.5.5 — the RED work turn: (optionally) author a test-glob file, then write the phase-result file the
  // completion:red gate classifies, from the ONE canonical examplePhaseResult. The test file sits OUTSIDE
  // .agent-terminal (a real test path that rides into the approve commit); the result file sits UNDER it.
  const writeResult = (outcome: PhaseOutcome, build?: BuildOutcome): string =>
    writePhaseResultSh(opts.artifactRel, examplePhaseResult(outcome, build ? { build } : undefined), exampleCapturedOutput(outcome));
  const writeRedTest =
    opts.writeTest === false
      ? ''
      : `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(3); });' > tests/red_added.test.ts`;
  const redBody = [bump, writeRedTest, writeResult(opts.resultOutcome ?? 'failed-assertion')];
  // §28.5.3 — the GREEN work turn: the frozen check diffs the committed baseline against the working tree, so
  // editing the committed tests/frozen.test.ts is what raises the flag.
  const testEdit = `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(2); });' 'extra' >> tests/frozen.test.ts`;
  const featureEdit = `printf '%s\\n' 'export const y = 2;' > feature.ts`;
  const greenBody = [
    bump,
    opts.touchTest === true ? testEdit : featureEdit,
    writeResult(opts.resultOutcome ?? 'passed', opts.buildOutcome ?? 'built'),
  ];
  const workBody: string[] | null =
    opts.work === 'noop'
      ? null
      : opts.work === 'ask'
        ? [bump, `mkdir -p .agent-terminal; : > .agent-terminal/asked; echo 'Question: may I proceed? (yes)'`]
        : opts.work === 'green'
        ? greenBody
        : opts.work === 'red'
          ? redBody
          : opts.work === 'refactor'
            ? [bump]
            : opts.work === 'file-only'
              ? [bump, writeArtifact(true)]
              : opts.work === 'no-marker'
                ? [bump, writeArtifact(false)]
                : [bump, writeArtifact(true)];
  const signals = opts.work !== 'noop' && opts.work !== 'file-only' && opts.work !== 'ask';
  const workAction =
    workBody === null
      ? ':'
      : [...workBody, byTurn('n', opts.extraShell?.work), ...(signals ? [doneSignal(turnKey)] : [])]
          .filter((s) => s.length > 0)
          .join('; ');
  const workAct = opts.hold ? `${count(turnKey, 'n')}; ${heldAction(opts.hold.sentinel, workAction)}` : `${count(turnKey, 'n')}; ${workAction}`;

  const reviewBump = 'mkdir -p .agent-terminal; printf x >> .agent-terminal/review-runs';
  const reviewKind = opts.review ?? 'full';
  const full = b64(exampleRoundReport({ sections, roster }));
  const omit = b64(exampleRoundReport({ sections, roster: [roster[0]] }));
  const failed = b64(failedReport(sections, roster));
  const needsHuman = b64(roundReportWithDisposition(sections, roster, 'needs a human'));
  const notLoaded = b64(firstMarkedReport(sections, roster, 'not loaded'));
  const r1 = reviewKind === 'failed' ? failed : reviewKind === 'not-loaded' ? notLoaded : reviewKind === 'omit-persona' || reviewKind === 'omit-then-repair' ? omit : full;
  const r2 = (opts.review2 ?? 'full') === 'failed' ? failed : full;
  const roundCases = (opts.reviews ?? []).map((k, i) => `${i + 1}) RB='${k === 'needs-human' ? needsHuman : full}' ;;`).join(' ');
  // Round-aware report write: the round is read from the §27 run-state so a re-review (round 2) writes to
  // reports/2.json, keeping the last-two-report window real (§27.6/AC2).
  const writeReportRoundAware =
    'r=$(rnd); mkdir -p .agent-terminal/loop/reports; ' +
    `RB='${r1}'; case "$r" in 2) RB='${r2}' ;; esac; ` +
    (roundCases.length > 0 ? `case "$r" in ${roundCases} esac; ` : '') +
    `[ -f .agent-terminal/repairing ] && RB='${full}'; ` +
    'printf %s "$RB" | base64 -d > .agent-terminal/loop/reports/$r.json';
  // §28.5.3 — a REFACTOR loop's review ROUND also writes the round-keyed phase-result the gate reads and makes a
  // behavior-preserving change so the approve commit has content.
  const writeRefactorResult =
    `r=$(rnd); ${writePhaseResultSh('.agent-terminal/loop/refactor-results/$r.json', examplePhaseResult(opts.resultOutcome ?? 'passed'))}`;
  const touchFrozenTest = `mkdir -p tests; printf '%s\\n' 'review-round edit' >> tests/frozen.test.ts`;
  const reviewExtra = byTurn('n', opts.extraShell?.review);
  const reviewAct =
    `${count(reviewKey, 'n')}; ` +
    (reviewKind === 'none'
      ? `${reviewBump}; ${reviewExtra}`
      : opts.work === 'refactor'
        ? `${reviewBump}; ${writeReportRoundAware}; ${opts.touchTest === true ? testEdit : featureEdit}; ${writeRefactorResult}; ${reviewExtra}; ${doneSignal(reviewKey)}`
        : opts.work === 'green' && opts.reviewTouchesTest === true
          ? `${reviewBump}; ${writeReportRoundAware}; ${touchFrozenTest}; ${reviewExtra}; ${doneSignal(reviewKey)}`
          : `${reviewBump}; ${writeReportRoundAware}; ${reviewExtra}; ${doneSignal(reviewKey)}`);

  // The consolidator writes its verdict output (round-keyed) then signals.
  const verdictCase = (opts.verdicts ?? []).map((v, i) => `${i + 1}) OUTB='${b64(v)}' ;;`).join(' ');
  const attemptCase = (opts.consolidateAttempts ?? []).map((v, i) => `${i + 1}) OUTB='${b64(v)}' ;;`).join(' ');
  const consolidateAction =
    'mkdir -p .agent-terminal; printf x >> .agent-terminal/consolidate-runs; ' +
    `r=$(rnd); OUTB='${b64(verdictOutput('clean'))}'; case "$r" in ${verdictCase} esac; case "$n" in ${attemptCase} esac; ` +
    'mkdir -p .agent-terminal/loop/consolidate; printf %s "$OUTB" | base64 -d > .agent-terminal/loop/consolidate/$r.json; ' +
    `${byTurn('n', opts.extraShell?.consolidate)}; ${doneSignal(consolidateKey)}`;
  const consolidateAct = opts.holdConsolidate
    ? `${count(consolidateKey, 'n')}; ${heldAction(opts.holdConsolidate.sentinel, consolidateAction)}`
    : `${count(consolidateKey, 'n')}; ${consolidateAction}`;

  return [
    `    *turn-done:${consolidateKey}*) ${consolidateAct} ;;`,
    `    *turn-done:${reviewKey}*) ${reviewAct} ;;`,
    `    *turn-done:${turnKey}*) ${workAct} ;;`,
    ...(opts.work === 'ask' ? [`    yes) [ -f .agent-terminal/asked ] && { rm .agent-terminal/asked; ${writeArtifact(true)}; ${doneSignal(turnKey)}; } ;;`] : []),
  ];
}

// A scriptable §27 fake-agent (§27.15 test seam), one per run and scripted per step: each step's arms match only
// that step's `work-`, `review-` and `consolidate-` turn keys. On the app WORK prompt it produces the §27
// completion artifact and/or done-file IN THE §27 LOOP AREA (.agent-terminal/loop/); on the chained
// REVIEW-AND-FIX prompt it writes the round report + the review done-file. It records the boundary commands and
// bumps per-turn counters so an e2e can prove a turn was (or was NOT) re-run. Per-step turn counts live under
// `binDir`, outside the worktree, so no phase commit stages them.
export function seedFakeAgentSteps(binDir: string, steps: Record<string, StepScript>): void {
  const scripts = Object.entries(steps);
  // A step id that prefixes another (`red`, `red-2`) must not capture its turns, so longer ids match first.
  const ordered = [...scripts].sort(([a], [b]) => b.length - a.length);
  const repairing = scripts.find(([, s]) => s.review === 'omit-then-repair')?.[1];
  const repairArm = repairing
    ? `    *"This is a REPAIR of the round-"*) mkdir -p .agent-terminal; : > .agent-terminal/repairing; r=$(rnd); mkdir -p .agent-terminal/loop/reports; ` +
      `printf %s '${b64(exampleRoundReport({ sections: repairing.sections ?? PLAN_V2_SECTIONS, roster: repairing.roster ?? PLAN_V2_ROSTER }))}' | base64 -d > .agent-terminal/loop/reports/$r.json ;;\n`
    : '';
  const logInjected = scripts.some(([, s]) => s.logInjected === true)
    ? '  mkdir -p .agent-terminal; printf "%s\\n" "$line" >> .agent-terminal/injected-log\n'
    : '';
  const script =
    '#!/usr/bin/env bash\n' +
    'rnd() { r=$(grep -m1 "^round:" .agent-terminal/loop/run-state.yaml 2>/dev/null | tr -dc "0-9"); [ -z "$r" ] && r=1; printf %s "$r"; }\n' +
    turnCountFn(binDir) +
    'while IFS= read -r line; do\n' +
    logInjected +
    '  [ -z "$line" ] && continue\n' +
    '  case "$line" in\n' +
    '    /clear) mkdir -p .agent-terminal; printf x >> .agent-terminal/clear-seen ;;\n' +
    repairArm +
    '    *"ELECTRON_RUN_AS_NODE=1 "*) mkdir -p .agent-terminal; { eval "ELECTRON_RUN_AS_NODE=1 ${line#*ELECTRON_RUN_AS_NODE=1 }"; printf "exit=%s\\n" "$?"; } >> .agent-terminal/checker-log 2>&1 ;;\n' +
    '    /compact*) mkdir -p .agent-terminal; printf x >> .agent-terminal/compact-seen ;;\n' +
    ordered.flatMap(([id, s]) => stepArms(id, s)).join('\n') +
    '\n  esac\n' +
    'done\n';
  writeFileSync(join(binDir, 'fake-agent'), script, { mode: 0o755 });
}

/** The one-step call of `seedFakeAgentSteps`. */
export function seedFakeAgentV2(binDir: string, opts: StepScript & { stepId: string }): void {
  const { stepId, ...step } = opts;
  seedFakeAgentSteps(binDir, { [stepId]: step });
}

export function writeCatalogEntry(home: string, id: string, yamlText: string): void {
  const file = catalogEntryDefFile(home, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yamlText);
}

export function seedCommitGateConfig(prefix: string): string {
  const cfg = mkdtempSync(join(tmpdir(), prefix));
  cpSync(exampleConfigDir, cfg, { recursive: true });
  const defPath = join(cfg, 'loops-v2', 'plan-loop', 'plan-loop.yaml');
  const def = readFileSync(defPath, 'utf8');
  const swapped = def.replace(
    '      - kind: gh\n        action: mark-ready',
    '      - kind: commit\n        label: "GREEN: s2-tracer"',
  );
  if (swapped === def) throw new Error('seedCommitGateConfig: plan-loop gh gate not found to swap');
  writeFileSync(defPath, swapped);
  return cfg;
}


// Clone the example config, set the plan-loop's work.completion, and swap its gh mark-ready gate for a commit
// side-effect carrying `label` — the shared shape of the §28.5 RED (S3) and GREEN (S4) tracer configs; they
// differ only in the completion value and the commit label.
export function seedCompletionGateConfig(prefix: string, completion: 'red' | 'green' | 'refactor', label: string): string {
  const cfg = mkdtempSync(join(tmpdir(), prefix));
  cpSync(exampleConfigDir, cfg, { recursive: true });
  const defPath = join(cfg, 'loops-v2', 'plan-loop', 'plan-loop.yaml');
  const def = readFileSync(defPath, 'utf8');
  const withCompletion = def.replace('work:\n  recipe: prompts/work.md\n  artifact: plan\n', `work:\n  recipe: prompts/work.md\n  artifact: plan\n  completion: ${completion}\n`);
  if (withCompletion === def) throw new Error(`seedCompletionGateConfig: plan-loop work block not found to set completion: ${completion}`);
  const swapped = withCompletion.replace('      - kind: gh\n        action: mark-ready', `      - kind: commit\n        label: "${label}"`);
  if (swapped === withCompletion) throw new Error('seedCompletionGateConfig: plan-loop gh gate not found to swap for commit');
  writeFileSync(defPath, swapped);
  return cfg;
}
// ---- §28.10 S7 — the full-TDD chain e2e: drive the SHIPPED flow end-to-end from a groomed ticket (AC1) ----
// A chain test drives one §27 loop per step; the per-test ceiling scales with the loops it drives, never the
// global 60 s default, so adding a step to the shipped flow cannot push a saturated runner past it.
const CHAIN_LOOP_MS = 15_000;
export const chainBudget = (loops: number): number => Math.ceil((WINDOW_TIMEOUT_MS + loops * CHAIN_LOOP_MS) / 30_000) * 30_000;
// §27.5
const CHAIN_STEPS = ['groom', 'plan-bundle', 'plan-polish', 'infra', 'red', 'green', 'refactor', 'integration-slice'] as const;
function shippedRoster(step: string): string[] {
  const repoDir = resolve(__dirname, '..', '..');
  const appBundled = resolveExampleLoopsV2Dir({ packaged: false, appPath: repoDir });
  const r = resolveLoopDefV2(`${step}-loop`, { tiers: { operator: null, appBundled, retired: null }, repoDir, flow: FEATURE_DEV_ID });
  if (!r.ok) throw new Error(`${step}-loop: ${r.reason}`);
  return r.def.reviewers.map((rev) => rev.persona);
}
export const CHAIN_ROSTERS: Record<string, string[]> = Object.fromEntries(CHAIN_STEPS.map((step) => [step, shippedRoster(step)]));

// A multi-step fake-agent driving the whole chain. Each review round writes a report accounting for that
// loop's roster (§27.5); the phase loops classify their §28.5 result files. The n-th consolidate turn of a step
// writes `verdicts[step][n-1]`, and `clean` when absent; on an all-`clean` chain the n-th red/green/refactor
// consolidate is impl-slice n's. Per-step turn counts live under `binDir`, outside the worktree.
export function seedFullTddChainAgent(
  binDir: string,
  opts: { implSlices?: number; polishedSlices?: number; logInjected?: boolean; verdicts?: Partial<Record<string, ConsolidatorVerdict[]>>; runChecksFor?: string[] } = {},
): void {
  const doneRel = `.agent-terminal/loop/${TURN_DONE_FILENAME}`;
  const done = (key: string): string => `mkdir -p .agent-terminal/loop; printf '%s' '${key}' > ${doneRel}`;
  const art = '.agent-terminal/loop/artifacts';
  const decode = (b64s: string, dst: string): string => `printf %s '${b64s}' | base64 -d > ${dst}`;
  const report = (step: string): string => b64(exampleRoundReport({ sections: ['summary', 'findings', 'disposition'], roster: CHAIN_ROSTERS[step] }));
  const check = (step: string): string =>
    opts.runChecksFor?.includes(step) ? `{ eval "$chk" </dev/null; printf 'exit=%s\\n' "$?"; } >> .agent-terminal/checker-log 2>&1; ` : '';
  // §28.4.1 D3 — when the ticket plans N impl-slices, the plan-bundle writes a `## Impl-slices` block the gate
  // sources the `slices` count from; otherwise the plan carries no block and the run stays a single slice.
  const planB64 = b64(
    opts.implSlices ? `# plan\n\n${exampleSlicePlan(opts.implSlices)}\n${completionMarker('plan-bundle')}\n` : `# plan\n${completionMarker('plan-bundle')}\n`,
  );

  const workArm: Record<string, string> = {
    groom: `mkdir -p ${art}; printf '%s\\n' '# groomed' '${completionMarker('groom')}' > ${art}/groomed-ticket.md; ${done('work-groom')}`,
    'plan-bundle': `mkdir -p ${art}; ${decode(planB64, `${art}/plan.md`)}; ${done('work-plan-bundle')}`,
    // §28.8.1 — with `polishedSlices` the polish turn rewrites the slice block, so a test can tell which gate's count won.
    'plan-polish': opts.polishedSlices
      ? `${decode(b64(`# plan\n\n${exampleSlicePlan(opts.polishedSlices)}\n${completionMarker('plan-bundle')}\n${completionMarker('plan-polish')}\n`), `${art}/plan.md`)}; ${done('work-plan-polish')}`
      : `printf '%s\\n' '${completionMarker('plan-polish')}' >> ${art}/plan.md; ${done('work-plan-polish')}`,
    infra: `printf '%s\\n' 'export const infra = 1;' > infra.ts; ${done('work-infra')}`,
    // A RED re-entered for the same slice (§28.4.2 back-to-RED) must ADD a test again, so a redo writes a new file.
    red: `mkdir -p tests; f=tests/red_added.test.ts; [ -f "$f" ] && f=tests/red_redo_$(ls tests | wc -l | tr -d ' ').test.ts; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(3); });' > "$f"; ${writePhaseResultSh('"${RES:-' + art + '/red-result.json}"', examplePhaseResult('failed-assertion'), exampleCapturedOutput('failed-assertion'))}; ${done('work-red')}`,
    // GREEN and refactor write content that differs per turn, so slice 2's approve has something to commit.
    green: `n=$(turn_count work-green); printf '%s\\n' "export const feat = $n;" > feature.ts; ${writePhaseResultSh('"${RES:-' + art + '/green-result.json}"', examplePhaseResult('passed', { build: 'built' }))}; ${done('work-green')}`,
    refactor: done('work-refactor'),
    'integration-slice': `printf '%s\\n' 'export const integ = 3;' > integration.ts; ${done('work-integration-slice')}`,
  };
  const reviewArm = (step: string): string => {
    const base = `mkdir -p .agent-terminal/loop/reports; r=$(rnd); ${decode(report(step), '.agent-terminal/loop/reports/$r.json')}`;
    // refactor-loop's gate commits, so its round leaves a behavior-preserving edit for that commit to record.
    return step === 'refactor'
      ? `${base}; ${writePhaseResultSh('.agent-terminal/loop/refactor-results/$r.json', examplePhaseResult('passed'))}; n=$(turn_count review-refactor); printf '%s\\n' "export const rf = $n;" > refactor.ts; ${done('review-refactor')}`
      : `${base}; ${check(step)}${done(`review-${step}`)}`;
  };
  const consolidateArm = (step: string): string => {
    const scripted = (opts.verdicts?.[step] ?? []).map((v, i) => `${i + 1}) OUTB='${b64(exampleConsolidatorOutput(v, CHAIN_ROSTERS[step]))}' ;;`).join(' ');
    return (
      `n=$(turn_count consolidate-${step}); OUTB='${b64(exampleConsolidatorOutput('clean', CHAIN_ROSTERS[step]))}'; case "$n" in ${scripted} esac; ` +
      `r=$(rnd); mkdir -p .agent-terminal/loop/consolidate; printf %s "$OUTB" | base64 -d > .agent-terminal/loop/consolidate/$r.json; ${check(step)}${done(`consolidate-${step}`)}`
    );
  };

  const steps = CHAIN_STEPS;
  const cases = steps
    .flatMap((s) => [
      `    *turn-done:consolidate-${s}*) ${consolidateArm(s)} ;;`,
      `    *turn-done:review-${s}*) ${reviewArm(s)} ;;`,
      `    *turn-done:work-${s}*) ${workArm[s]} ;;`,
    ])
    .join('\n');
  const script =
    '#!/usr/bin/env bash\n' +
    'rnd() { r=$(grep -m1 "^round:" .agent-terminal/loop/run-state.yaml 2>/dev/null | tr -dc "0-9"); [ -z "$r" ] && r=1; printf %s "$r"; }\n' +
    turnCountFn(binDir) +
    'while IFS= read -r line; do\n' +
    '  [ -z "$line" ] && continue\n' +
    (opts.logInjected ? '  mkdir -p .agent-terminal; printf "%s\\n" "$line" >> .agent-terminal/injected-log\n' : '') +
    '  case "$line" in\n' +
    '    /clear) mkdir -p .agent-terminal; printf x >> .agent-terminal/clear-seen ;;\n' +
    '    /compact*) mkdir -p .agent-terminal; printf x >> .agent-terminal/compact-seen ;;\n' +
    // §28.4 D1 — honor the phase-result path the prompt names (`red-result.slice-N.json` on a loop-back
    // re-entry), so a real agent writing where told is modeled rather than a hardcoded slice-1 filename.
    '    *"Write the classification to "*) t=${line#*Write the classification to }; RES=${t%% as a JSON object*} ;;\n' +
    `${cases}\n` +
    '    *"ELECTRON_RUN_AS_NODE=1 "*) chk="ELECTRON_RUN_AS_NODE=1 ${line#*ELECTRON_RUN_AS_NODE=1 }" ;;\n' +
    '  esac\n' +
    'done\n';
  writeFileSync(join(binDir, 'fake-agent'), script, { mode: 0o755 });
}
