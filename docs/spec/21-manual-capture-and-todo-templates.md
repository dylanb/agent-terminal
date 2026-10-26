## 21. Manual capture & todo templates

### 21.1 Manual single-slot capture (D39)

- Capture is **manual and single-slot**: "Capture last report" runs report-detection (§15.3) on demand against the current shadow buffer, and each capture **replaces** the prior one. Nothing is auto-emitted, so the pane never accumulates stale reports that need dismissing or deduplicating.
- The captured report splits into findings (§15.7), each individually addable as a todo — the source of **review-todo curation** at the request-changes gate (§19.4).

### 21.2 Todo templates (D12/D38)

- Templates are plain **markdown lists** (global ones in `~/.config/agent-terminal/todo-templates/`, or files a step references, §18.6): each top-level list item becomes one active todo, and headings/prose are ignored so a template can carry a title and instructions. They reuse the flat todo model (§16.3) — no new on-disk schema.

---
