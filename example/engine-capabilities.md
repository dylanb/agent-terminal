# Agent Terminal engine capabilities

What the engine accepts in a flow definition and a loop definition, where flows and loops live, and the contract a loop’s turns follow. Generated from the definitions the engine itself loads, so it always matches the app that installed it.

- [Flow definitions](#flow-definitions)
  - [flow](#flow)
    - [`name`](#name)
    - [`steps`](#steps)
  - [flow.steps](#flowsteps)
    - [`id`](#id)
    - [`kind`](#kind)
    - [`loop`](#loop)
    - [`gate_authority`](#gate_authority)
    - [`loop_namespace`](#loop_namespace)
    - [`skill`](#skill)
    - [`todo_template`](#todo_template)
    - [`bootstrap`](#bootstrap)
    - [`inputs`](#inputs)
    - [`repeat`](#repeat)
  - [flow.steps.inputs](#flowstepsinputs)
    - [`name`](#name-1)
    - [`type`](#type)
    - [`required`](#required)
  - [flow.steps.repeat](#flowstepsrepeat)
    - [`back_to`](#back_to)
    - [`count_input`](#count_input)
    - [`count_from`](#count_from)
  - [flow.steps.repeat.count_from](#flowstepsrepeatcount_from)
    - [`artifact`](#artifact)
    - [`format`](#format)
    - [`list`](#list)
- [Loop definitions](#loop-definitions)
  - [loop](#loop-1)
    - [`version`](#version)
    - [`name`](#name-2)
    - [`brief`](#brief)
    - [`work`](#work)
    - [`reviewers`](#reviewers)
    - [`consolidator`](#consolidator)
    - [`report`](#report)
    - [`gate`](#gate)
    - [`exec`](#exec)
    - [`outputs`](#outputs)
    - [`boundaries`](#boundaries)
    - [`pickup`](#pickup)
    - [`inputs`](#inputs-1)
  - [loop.work](#loopwork)
    - [`recipe`](#recipe)
    - [`artifact`](#artifact-1)
    - [`completion`](#completion)
    - [`frozen_check`](#frozen_check)
    - [`goal`](#goal)
    - [`checkpoint`](#checkpoint)
  - [loop.work.checkpoint](#loopworkcheckpoint)
    - [`passes`](#passes)
  - [loop.reviewers](#loopreviewers)
    - [`persona`](#persona)
    - [`charter`](#charter)
    - [`tools`](#tools)
  - [loop.consolidator](#loopconsolidator)
    - [`recipe`](#recipe-1)
  - [loop.boundaries](#loopboundaries)
    - [`boundary`](#boundary)
    - [`mode`](#mode)
    - [`message`](#message)
  - [loop.report](#loopreport)
    - [`sections`](#sections)
    - [`polish`](#polish)
  - [loop.gate](#loopgate)
    - [`option`](#option)
    - [`side_effects`](#side_effects)
  - [loop.gate.side_effects](#loopgateside_effects)
    - [`kind`](#kind-1)
      - [`gh` `action`](#gh-action)
      - [`gh` `artifact`](#gh-artifact)
      - [`commit` `label`](#commit-label)
      - [`promote` `artifact`](#promote-artifact)
  - [loop.pickup](#looppickup)
    - [`initial_status`](#initial_status)
    - [`branch_template`](#branch_template)
    - [`initial_labels`](#initial_labels)
    - [`on_conflict`](#on_conflict)
  - [loop.pickup.initial_labels](#looppickupinitial_labels)
    - [`action`](#action)
    - [`target`](#target)
    - [`label`](#label)
  - [loop.inputs/outputs](#loopinputsoutputs)
    - [`id`](#id-1)
    - [`path`](#path)
    - [`sections_dir`](#sections_dir)
  - [loop.exec](#loopexec)
    - [`program`](#program)
- [Where flows and loops live](#where-flows-and-loops-live)
- [How a loop name resolves](#how-a-loop-name-resolves)
- [The turn contract](#the-turn-contract)
  - [How briefs, recipes and charters become turns](#how-briefs-recipes-and-charters-become-turns)

## Flow definitions

### `flow`

A key not listed here is ignored.

#### `name`

The flow’s name, shown in the flow picker and the run’s records.

When: Always set it: a flow with no name, or an empty one, fails to load.

**Required.**

#### `steps`

The flow’s steps, in the order a run moves through them.

When: Always set it to a list with at least one step; an empty or missing list fails to load.

**Required.**

### `flow.steps[]`

A key not listed here is ignored.

#### `id`

The step’s identifier; `repeat.back_to` and the run’s records refer to it by this value.

When: Always set it to a non-empty string.

**Required.**

#### `kind`

What kind of step this is.

When: Always set it; any value outside the list fails to load.

**Required.**

Values:

- `manual` — A person produces the step’s artifact by hand; the step is done when they say so. It is never sent back for more work. When: Choose it for work no loop automates: a review, a decision, or anything a person does at the keyboard.
- `loop` — Runs the loop definition named by `loop` (work turn, reviews, gate) until a person or the gate authority approves it. When: Choose it for agent work that should be reviewed and can be sent back for another round.

#### `loop`

The name of the loop definition the step runs, resolved through the loop lookup order.

When: Set it on every `loop` step; a `manual` step ignores it.

**Required when** the step’s `kind` is `loop`.

Rules the loader enforces:

- A `loop` step without a non-empty `loop` fails to load.

#### `gate_authority`

Who decides the loop’s gate.

When: Set it only to let the engine approve a clean loop; leave it out for a person to decide.

**Optional.**

Rules the loader enforces:

- Declaring it on a step whose `kind` is not `loop` fails to load.

Values:

- `human` — A person decides every gate option of the loop. When: Choose it, or leave the key out, whenever a person should approve the artifact. It is the default.
- `auto` — The engine takes Approve itself when the loop finishes clean; every other option, and every halt, stays with a person. When: Choose it for a loop whose clean result needs no human sign-off.

#### `loop_namespace`

Which loop engine runs the step’s loop. Read on `loop` steps only.

When: Leave it out: the default binds the working engine.

**Optional.**

Rules the loader enforces:

- With `app` declared explicitly, a `loop` that is not a single safe path segment (no `/`, no `..`) fails the whole file to load.

Values:

- `app` — Binds the loop to the app’s own loop engine, which resolves the definition through the loop lookup order. Selects a working engine. When: Choose it, or leave the key out, for every loop step: it is the default and the only working engine.
- `legacy` — Names the retired loop engine. The flow still loads, but this step fails with a reason when it is entered. Selects no working engine. When: Exists only so older flow files keep loading; never choose it for a new flow.

#### `skill`

A Claude Code skill, by registered name or repository-relative file path, that the app invokes in the agent when the step is entered.

When: Set it when the agent should load a playbook for the step. It must be a string.

**Optional.**

#### `todo_template`

The to-do template the template picker selects by default for this step: the file name, with or without its extension, of one of the templates in the to-do templates folder beside the flow’s definition (see where flows and loops live).

When: Set it when the step has a checklist a person usually starts from. It must be a string.

**Optional.**

#### `bootstrap`

An action the app runs on entry to the step.

When: Set it on the step that starts work on a ticket; any other value fails to load.

**Optional.**

Values:

- `pickup` — On entry to the step, runs the bound loop definition’s `pickup` contract (branch, status and labels) for the step’s ticket input. When: Choose it on the step that starts work on a ticket. It is the only bootstrap; a step bound to a definition with no `pickup` contract does not run.

#### `inputs`

The typed inputs the step declares; on entry the app prompts for each required one that has no value yet, before any `bootstrap` runs.

When: Set it on the step that first needs a ticket, a pull request, or a value such as a slice count. It must be a list.

**Optional.**

#### `repeat`

Loops the flow back: on leaving this step, the run returns to an earlier step instead of going on, a number of times read from an input (`count_input`) or from a list in an artifact (`count_from`).

When: Set it to run a group of steps once per entry of a list, for example red, green and refactor for each slice of a plan.

**Optional.**

### `flow.steps[].inputs[]`

A key not listed here is ignored.

#### `name`

The input’s name; `repeat.count_input` and the prompts refer to it.

When: Always set it to a string.

**Required.**

#### `type`

The input’s type, which picks the prompt the app shows for it.

When: Always set it to a string; choose an acted-on type when the engine should use the value.

**Required.**

Names the engine acts on:

- `github-ticket` — A GitHub issue number. The engine reads it as the run’s ticket and records the association in the run’s audit log. When: Choose it for the input that names the ticket the flow works on.
- `pr` — A pull-request number. The engine reads it as the run’s pull request. When: Choose it for the input that names the pull request the flow works on.

Any other type loads, and the engine acts on its value only where another key names the input by `name`, as `repeat.count_input` does.

#### `required`

Whether the step can be entered without the input. Only the value `true` makes it required; anything else is read as false.

When: Set it to `true` when the step cannot run without the value.

**Optional.**

### `flow.steps[].repeat`

A key not listed here is ignored.

#### `back_to`

The `id` of the step the run returns to.

When: Always set it to the first step of the group to repeat.

**Required.**

Rules the loader enforces:

- A `back_to` that does not name a step declared before this one (unknown, later, or this step itself) fails to load.

#### `count_input`

The `name` of the input that holds how many times the group runs.

When: Set it to an input a plan or a person fills with the slice count, when the count does not come from `count_from`.

**Required when** the repeat has no `count_from`.

Not checked when the definition loads; at run time:

- When no input has that name, or it has no value, the group runs once.
- When the value is not a whole number, the group runs once.
- When the value is below 1, the group runs once.
- When the value is above 50, the group runs 50 times.

#### `count_from`

The list in an artifact whose entries set how many times the group runs. Until a list sets the count, the group runs once.

When: Set it when a step’s artifact lists the entries the group works through, when the count does not come from `count_input`.

**Required when** the repeat has no `count_input`.

Rules the loader enforces:

- A repeat that declares both `count_input` and `count_from`, or neither, fails to load.

### `flow.steps[].repeat.count_from`

A key not listed here is ignored.

#### `artifact`

The loop output id of the artifact that holds the list.

When: Always set it to a non-empty string; an empty or non-string value fails to load.

**Required.**

#### `format`

How the artifact holds the list.

When: Always set it; any value outside the list fails to load.

**Required.**

Values:

- `impl-slices` — The artifact’s `## Impl-slices` block, read as a plan’s is: one entry per slice heading. When: Choose it when the artifact is a plan-shaped Markdown file.
- `json-list` — A JSON object whose `list` key holds an array of entries, each an object whose `title` is a string that is non-empty after trimming and holds no control character, a line break included. When: Choose it for any other list an agent writes; the file must be JSON.

#### `list`

The top-level key of the `json-list` file whose array holds the entries.

When: Set it to a non-empty string when `format` is `json-list`.

**Required when** the `format` is `json-list`.

Rules the loader enforces:

- A `json-list` source without a non-empty string `list`, or an `impl-slices` source with any `list`, fails to load.

## Loop definitions

### `loop`

A key not listed here fails the definition to load.

#### `version`

The schema version of the definition.

When: Always set it.

**Required.**

Values:

- `v2` — The loop-definition schema this engine reads. When: Always: it is the only version the engine loads.

#### `name`

The loop’s name. The engine names a loop by the folder and file it resolves from, so this only restates it.

When: Leave it out, or set it to the name the loop resolves by.

**Optional.**

Rules the loader enforces:

- A `name` other than the name the loop resolves by fails to load.

#### `brief`

A Markdown file, relative to the definition, that opens every work turn's prompt with the role the agent plays. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Set it when every work turn of the loop shares one role description.

**Optional.**

#### `work`

The work turn: the recipe the agent follows and the artifact it produces.

When: Always set it.

**Required.**

#### `reviewers`

The reviewers that review the work, each a persona with its charter.

When: Always set it to a list; leave the list empty for a loop with no reviews.

**Required.**

Rules the loader enforces:

- A non-empty list fails to load unless a `consolidator` judges the review rounds or a `work.goal` runs the reviewers itself.

#### `consolidator`

The turn that merges the reviewers’ findings each round into one verdict.

When: Set it on a loop whose review rounds the engine runs one by one.

**Required when** the loop declares reviewers and no `work.goal`.

Rules the loader enforces:

- Declaring it beside a `work.goal` fails to load: a goal session runs its reviewers itself.

#### `report`

The structure of each review round’s report.

When: Always set it.

**Required.**

#### `gate`

The options a person, or the gate authority, can take once the loop reaches its gate.

When: Always set it to a list; a loop that should finish declares `approve`.

**Required.**

#### `exec`

A program the definition declares. Declared but not shipped: the loader reads it and no engine runs it.

When: Leave it out.

**Optional.**

#### `outputs`

The files the loop writes, each bound to an `id` the work turn, the gate and later steps refer to.

When: Set it for every file the loop produces.

**Required when** `work.completion` is `red` or `green`: one output’s `id` must be `work.artifact`.

Rules the loader enforces:

- With `work.completion` `red` or `green`, a `work.artifact` that names no output fails to load.

#### `boundaries`

The context policy at each point the engine changes turn.

When: Always set it to a list; leave it empty to clear the context at every point the engine changes turn.

**Required.**

#### `pickup`

What a flow step’s `bootstrap: pickup` does for the ticket: the branch it opens, the status it sets and the labels it changes.

When: Set it on the loop of a flow step that starts work on a ticket.

**Optional.**

#### `inputs`

The files the loop reads, each bound to an `id`.

When: Set it for every file an earlier step wrote that the loop needs.

**Optional.**

### `loop.work`

A key not listed here is ignored.

#### `recipe`

A Markdown file, relative to the definition, holding the instructions the work turn follows. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Always set it.

**Required.**

#### `artifact`

The `id` of the output the work turn produces.

When: Always set it.

**Required.**

#### `completion`

Which machine check the step’s completion waits on.

When: Set it on a test-driven phase loop; leave it out for a loop a person or a review approves.

**Optional.**

Values:

- `red` — The work turn writes failing tests: the step completes only when its result file shows the new tests failing by assertion. When: Choose it for the test-first step of a red, green, refactor cycle.
- `green` — The work turn makes the tests pass: the step completes only when its result file shows the tests passing and the build succeeding, with the previous phase’s tests left unchanged. When: Choose it for the step that implements what the failing tests describe.
- `refactor` — Each review-and-fix round is gated instead of the work turn, which writes no result file; the previous phase’s tests must stay unchanged. When: Choose it for a clean-up step that must keep behaviour and tests as they are.

#### `frozen_check`

Whether the loop runs the frozen-tests check.

When: Leave it out unless the loop must not change existing tests.

**Optional.**

Values:

- `true` — Holds the tests the previous phase committed frozen: before the gate opens, the engine checks that this loop’s work did not change them. When: Set it on a loop whose completion is not `green` or `refactor` (those already run the check) that must not touch existing tests. It is the only value.

#### `goal`

Runs the work as one agent goal session that ends when this condition holds, with the agent running its reviewers itself. One line, at most 2000 characters.

When: Set it for a loop the agent should drive to completion on its own.

**Optional.**

#### `checkpoint`

Splits a goal session into legs: after the given number of review passes the session is compacted and resumes.

When: Set it on a long goal session whose context would otherwise fill.

**Optional.**

Rules the loader enforces:

- Declaring it without `goal` fails to load: only a goal session runs in legs.

### `loop.work.checkpoint`

A key not listed here is ignored.

#### `passes`

How many review passes a leg runs before the session checkpoints.

When: Always set it to a whole number of at least 1.

**Required.**

### `loop.reviewers[]`

A key not listed here is ignored.

#### `persona`

The reviewer’s name, a single path segment. The agent each review round calls is named after the loop and this persona.

When: Always set it.

**Required.**

#### `charter`

A Markdown file, relative to the definition, holding the reviewer's instructions. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Always set it.

**Required.**

#### `tools`

The tools the reviewer may use, as a list of tool names; with no list it may use every tool.

When: Set it to keep a reviewer read-only or narrow.

**Optional.**

### `loop.consolidator`

A key not listed here is ignored.

#### `recipe`

A Markdown file, relative to the definition, holding the instructions the consolidating turn follows. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Always set it.

**Required.**

### `loop.boundaries[]`

A key not listed here is ignored.

#### `boundary`

The point the policy applies at: the first boundary listed applies before the work turn, the one named `pre-review` before each review round, and the one named `pre-consolidate` before each consolidating turn. A point with no boundary declared clears the context.

When: Always set it.

**Required.**

#### `mode`

What happens to the agent’s context at the boundary.

When: Always set it.

**Required.**

Values:

- `clear` — Clears the agent’s context at the boundary, so the next turn starts from its prompt alone. When: Choose it when the next turn should not see the work before it, for example before reviews.
- `compact` — Compacts the agent’s context at the boundary, keeping what `message` names. When: Choose it when the next turn needs a summary of what came before.

#### `message`

What the compacted context keeps.

When: Set it on every `compact` boundary.

**Required when** the `mode` is `compact`.

Rules the loader enforces:

- A `compact` boundary without a `message` fails to load.

### `loop.report`

A key not listed here is ignored.

#### `sections`

The sections each round report must carry, as a list of strings.

When: Always set it.

**Required.**

#### `polish`

What review rounds do with a finding that is polish only.

When: Set it to `defer` only when a later loop polishes the work.

**Optional.**

Values:

- `fix` — Review rounds fix polish-only findings as well as defects. When: Choose it, or leave the key out, for a loop that should leave its work fully polished. It is the default.
- `defer` — Review rounds dismiss polish-only findings, leaving them to a later loop that reviews the whole change. When: Choose it for an early loop in a flow whose later loop polishes the work.

### `loop.gate[]`

A key not listed here is ignored.

#### `option`

The option’s name, shown as a button on the gate.

When: Always set it; declare each option a person should be able to take.

**Required.**

Rules the loader enforces:

- A `request-changes` option on a loop with no `consolidator` fails to load: it re-enters a review round, and only a consolidator’s rounds can be re-entered.

Names the engine acts on:

- `approve` — Accepts the artifact and moves the flow to its next step, running the option’s `side_effects` first. When: Declare it on every loop that should be able to finish.
- `request-changes` — Sends a person’s written feedback into another review-and-fix round. When: Declare it on a loop with a `consolidator`, so a person can ask for specific changes.
- `impasse` — Shows a button that does nothing when taken: the engine runs no action for it. When: Declare it only to show that the loop can end in an impasse; it never moves the run.
- `redo` — Starts the work turn again from a clean slate with a person’s written instruction. When: Declare it when a person may want the work redone rather than revised.
- `polish` — Stands the loop down so a person can polish the work by hand; Approve ends it. When: Declare it on a loop whose output a person may want to finish themselves.
- `back-to-red` — Returns the flow to the current slice’s red step, with an optional written brief, so the slice is redone from its tests. When: Declare it on the green and refactor loops of a red, green, refactor cycle.

Any other name loads and shows as a button, but taking it does nothing: the app refuses it before it reaches the engine.

#### `side_effects`

What the engine runs when the option is `approve`, in the order listed; on any other option they never run.

When: Set it on the `approve` option to publish, commit or promote the loop’s work.

**Optional.**

### `loop.gate[].side_effects[]`

A key not listed here is ignored.

#### `kind`

What the side effect does. Every other key of the entry is kept as the side effect’s args, which the loader does not check; the args each kind reads are listed under it.

When: Always set it.

**Required.**

Names the engine acts on:

- `gh` — Runs a GitHub action against the run’s pull request or ticket, named by `action`. When: Choose it to publish a loop’s output to GitHub or mark the pull request ready.
- `commit` — Commits the work under `label`, then pushes the branch when pickup opened one. When: Choose it on each phase loop of a flow that should record one commit per phase.
- `promote` — Reads the plan named by `artifact` and, when it is an epic, offers to promote its sub-tickets before the approval completes. When: Choose it on a planning loop whose plan may split the work into sub-tickets.

`exec` fails to load: a program is declared on the top-level `exec` key instead. Any other kind loads and is skipped when the option is taken.

##### `gh` `action`

The GitHub action to run.

When: Always set it; a `gh` side effect does nothing useful without one.

**Required when** the option is taken: without it the side effect fails. The loader does not check it.

Names the engine acts on:

- `mark-ready` — Marks the run’s draft pull request ready for review. With no pull request it is skipped with a notice. When: Choose it on the last loop of a flow, when the work is ready for people to review.
- `update-issue-body` — Replaces the ticket’s body with the file named by `artifact`. With no ticket it is skipped with a notice; an empty file fails. When: Choose it on a grooming loop whose output is the ticket itself.
- `publish-pr-body` — Replaces the pull request’s description with the file named by `artifact`. With no pull request it is skipped with a notice; an empty file fails. When: Choose it on a loop that writes the pull request’s description.
- `publish-pr-review` — Publishes the adopted pull request review. When: Use on an adopted pull request run with its review artifact.

Any other name, or none, loads; taking the option then fails the side effect, which is recorded in the run’s audit log and shown as an error.

##### `gh` `artifact`

The `id` of one of the definition’s `inputs` or `outputs`, whose file the side effect reads.

When: Set it for an action that publishes a file.

**Required when** the `action` is `update-issue-body` or `publish-pr-body`: without it, or when it names no binding, the side effect fails.

##### `commit` `label`

The phase name the commit is recorded under.

When: Always set it, for example to the phase the loop runs.

**Required when** the option is taken: without it the commit fails. The loader does not check it.

##### `promote` `artifact`

The `id` of one of the definition’s `inputs` or `outputs`, whose file the side effect reads.

When: Set it to the plan the loop writes.

**Required when** the option is taken: without it no promotion is offered. The loader does not check it.

### `loop.pickup`

A key not listed here is ignored.

#### `initial_status`

The status pickup sets on the ticket.

When: Always set it to a non-blank status.

**Required.**

#### `branch_template`

The name of the branch pickup opens, with `{issue}` replaced by the ticket number.

When: Always set it.

**Required.**

#### `initial_labels`

Label changes pickup makes, in order.

When: Set it to mark the ticket or pull request as in progress.

**Optional.**

#### `on_conflict`

What pickup does when the branch already exists.

When: Leave it out to stop and ask.

**Optional.**

Values:

- `abort` — When the branch already exists locally, on the remote or with an open pull request, pickup stops and asks a person. When: Choose it, or leave the key out, to never lose earlier work on the branch. It is the default.
- `wipe-and-retry` — When the branch already exists, pickup offers to delete it and its pull request and start again. When: Choose it for a loop whose earlier attempts are safe to throw away.

### `loop.pickup.initial_labels[]`

A key not listed here is ignored.

#### `action`

Whether the label is added or removed.

When: Always set it.

**Required.**

Values:

- `add` — Adds the label. When: Choose it to mark the ticket or pull request as picked up.
- `remove` — Removes the label. When: Choose it to clear a label such as a "ready" marker on pickup.

#### `target`

Where the label is changed.

When: Always set it.

**Required.**

Values:

- `issue` — Applies the change to the run’s ticket. When: Choose it for a label on the GitHub issue.
- `pr` — Applies the change to the pull request pickup opens. When: Choose it for a label on the pull request.

#### `label`

The label’s name.

When: Always set it to a non-blank name the repository has.

**Required.**

### `loop.inputs[]/outputs[]`

A key not listed here is ignored.

#### `id`

The binding’s name, a single path segment; `work.artifact` and the side effects’ `artifact` refer to it.

When: Always set it.

**Required.**

Rules the loader enforces:

- The same `id` declared twice in one list fails to load.

#### `path`

The file's path inside the repository's loop artifacts folder; a path that leaves it fails to load. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Always set it.

**Required.**

#### `sections_dir`

A folder inside the loop artifacts folder where each step writes its own section of this file; the engine assembles the file from them. It is a path, never a body, and a `{…}` slot in it fails to load.

When: Set it on a report several steps add to.

**Optional.**

### `loop.exec`

A key not listed here is ignored.

#### `program`

The program to run. Declared but not shipped: no engine runs it.

When: Set it only when declaring `exec`.

**Required.**

## Where flows and loops live

Paths write your home directory as `~`, the repository the terminal runs in as `<repo>`, and the installed app's bundle as `<app>`. `<catalog-id>` is a catalog entry's folder name; `<flow-name>` is the flow definition's `name` value, which names the flow's own loop folder whatever its catalog folder is called. `APP_HOME_DIR`, set to an absolute path, replaces `~` in every `~/.agent-terminal` path. `CLAUDE_CONFIG_DIR`, set to an absolute path, replaces `~/.claude`.

- Repository flow: `<repo>/.agent-terminal/flow.yaml`, the flow the repository runs when no catalog flow is picked.
- Global flow: `~/.agent-terminal/flow.yaml`, the fallback for a repository with no flow of its own.
- Flow catalog: `~/.agent-terminal/flows/<catalog-id>/flow.yaml` and `<repo>/.agent-terminal/flows/<catalog-id>/flow.yaml`, the flows the picker offers; a repository entry wins over a global one of the same name.
- App-bundled flows: `<app>/example/flows/<catalog-id>/flow.yaml`, which Install examples copies into the flow catalog.
- To-do templates: `todo-templates/` beside a flow's `flow.yaml`, whose Markdown files the template picker lists; a step's `todo_template` names one by its file name, with or without the extension.
- Operator loop tier: `~/.claude/loops-v2/<loop>/<loop>.yaml`, and a flow's own loops at `~/.claude/loops-v2/<flow-name>/<loop>/<loop>.yaml`.
- App-bundled loop tier: `<app>/example/loops-v2/<loop>/<loop>.yaml`, and a flow's own loops at `<app>/example/loops-v2/<flow-name>/<loop>/<loop>.yaml`.
- Repository loop override: `<repo>/.agent-loop.yaml`, whose `loops` map gives a loop name the repository-relative path of its definition.
- This guide: `~/.agent-terminal/engine-capabilities.md`, replaced whole by every Install examples.

## How a loop name resolves

A `loop` step's definition is looked up in this order; the first one found wins.

1. The repository’s loop override file, when its map names the loop.
2. The operator tier’s folder named after the running flow’s `name`.
3. The app-bundled tier’s folder named after the running flow’s `name`.
4. The shared operator tier, outside any flow folder.
5. The shared app-bundled tier, outside any flow folder.

## The turn contract

What the engine and an agent running a loop step agree on: the lines and files a turn writes, the file a repository describes its tests in, and the `{…}` slots a definition may hold.

- `<!-- agent-terminal:work-turn-complete:<step> -->` — The marker line a work turn that produces a file writes as the last line of that file, with the step id in place of `<step>`. The engine counts the file as produced only when it holds this line.
- `turn-done` at `<repo>/.agent-terminal/loop/turn-done` — The file a turn writes as its very last action, holding only its turn key. Writing it is what ends the turn; anything the agent prints is ignored.
- `work-<step>` — The turn key of a step’s work turn, with the step id in place of `<step>`.
- `review-<step>` — The turn key of a step’s review-and-fix turn.
- `consolidate-<step>` — The turn key of a step’s consolidating turn.

`loop-capabilities.yaml`: The file at the repository root that describes the repository’s tests to the RED, GREEN and REFACTOR steps. A key not listed here fails the file.

- `test_globs` — **Required.** The globs naming the repository’s test files. The engine matches changed files against them to tell whether a turn added or changed a test.
- `test_command` — **Required.** The command that runs the tests. The engine never runs it; a recipe tells the agent to.
- `build_command` — **Required.** The command that builds the app. The engine never runs it; a recipe tells the agent to.
- `select_template` — **Optional.** Checked when the file is read, and otherwise unused by the engine.
- `red_check_command` — **Optional.** The command a RED turn is told to run to check that each test it added fails as intended, writing a red-check report. When it is set, the engine accepts the RED step only when that report is present and verifies. Without it, the RED step completes unchecked and is recorded as not independently checked.

- `{issue}` in `loop.pickup.branch_template` — The engine replaces this slot with the ticket number before it uses the value.

A `{…}` slot is never expanded in these places, so a definition with one in any of them fails to load: `loop.brief`, `loop.work.recipe`, `loop.reviewers[].charter`, `loop.consolidator.recipe`, `loop.inputs[].path`, `loop.outputs[].path`, `loop.inputs[].sections_dir`, `loop.outputs[].sections_dir`.

### How briefs, recipes and charters become turns

A loop step runs as turns, each one prompt the engine types into the agent’s session and one done-signal file the agent writes back.

- **Work turn.** The prompt is the loop’s `brief`, when it has one, followed by the `work.recipe` file’s body. The engine then adds what the run knows: the ticket the loop works, the paths of the step’s inputs, the report section the step writes, and the instruction to end the produced file with the marker line and to write the done-signal file last.
- **Review-and-fix turn.** The agent runs each reviewer in `reviewers[]` as a sub-agent installed from that reviewer’s `charter`, so the charter is the reviewer’s whole instructions. The engine hands every reviewer the same short hand-off naming the ticket and the inputs, and the agent fixes or dismisses what they find. The loop’s `brief`, when it has one, follows as standing instructions every fix must meet; a step in it that only the work turn takes, such as interviewing the operator, does not run again there.
- **Consolidating turn.** When the loop has a `consolidator`, its `recipe` body, with the last two rounds’ reports, decides whether another round runs.
- **Goal loops.** When `work.goal` is set, one goal session does the work and the reviews together, in legs when `work.checkpoint` is set, and records its progress in a file the engine reads to decide when the step is done.

Brief, recipe and charter files are read as written: the engine adds its own instructions around them and never edits them.
