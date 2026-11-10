## 20. Artifacts & the built-in viewer

### 20.1 Discovery & provenance (D8)

- The default review set is the **curated set**: §27 loop artifacts under `.agent-terminal/loop/` ∪ working-tree changes ∪ files the branch commits over its PR base, each tagged with its provenance (`loop`, `changed`, `pr`; a file may carry several). It is a **superset** on purpose: a file committed on the branch but clean in the working tree must still list, which a `git status`-only view would hide. The app's own state files directly under `.agent-terminal/` are excluded. A checkbox expands the tree to any file in the repo.
- The **PR base** is the merge-base with the base branch. It resolves from **local refs only** on the synchronous path (never a network round-trip); the real PR base from `gh` is refined off-thread and only re-pulls the viewer when it differs. A failed `gh` lookup never poisons the cache.
- **Before the first OSC 7 the tree root is the launch root (§23.4)**, not the Electron process dir; afterwards it follows the reported cwd.
- **Live reload:** main watches the tree root so an artifact re-renders on an external edit. The watch root is resolved through the same git-root discovery the tree uses, so the two cannot drift, and ignored directories are skipped at any depth so a refresh's own `git status` write cannot feed a reload loop. Of the app's gitignored state, the watch covers `.agent-loop/`, `.agent-terminal/` itself and its `loop/` tree — never other trees under `.agent-terminal/`, such as an agent's scratch builds. On macOS it is one recursive watch filtered to that coverage, because each separate watcher rebuilds one shared FSEvents stream and thousands of them block the main thread; on Linux each covered directory is watched separately, because a recursive watch spends an inotify watch on every directory, ignored ones included.

### 20.2 Viewer (D25/D35)

- Renders code (read-only, highlighted), markdown with Mermaid, and standalone Mermaid. **CodeMirror 6** is chosen for code because select-to-send needs strong text selection.
- **Changed-line markers** diff the working tree against the PR base (§20.1) — the superset, so committed-in-PR and uncommitted lines both mark in one pass, and a branch commit still highlights on a clean tree.
- **Select-to-send:** a viewer selection goes to the same two sinks as a terminal selection (inject §9.3, or a todo §16.2). A sink button's `mousedown` is `preventDefault`ed so focusing it does not collapse the selection it acts on.

### 20.3 GitHub as markdown (D19/D24)

- GitHub tickets and PR bodies are shown as markdown artifacts; the viewer prefers the agent/loop-written copies (e.g. `pr-context.md`, `ticket.md`).

---
