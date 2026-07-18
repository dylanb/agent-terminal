## 21. Manual capture & todo templates

### 21.1 Manual single-slot capture (D39 — reconciles §15/§16)

- Capture is **completely manual**: a **"Capture last report"** button runs report-detection (§15.3) **on demand** against the current shadow buffer (`capture:last`, §6); the pane holds **one** captured report — each capture **replaces** the prior.
- The captured report still **splits into findings** (§15.7 `splitFindings`), each individually **Add-to-todo**-able; the whole report can be added wholesale. **No auto-emit, no growing list, no Dismiss-all / dedup / retraction** (retired — §15.1/§15.2/§15.3/§15.6/§16.1/§16.2 amendments). Report-detection logic and the `SCANNER_DEBUG` `/tmp/scanner.log` trace are kept.
- This is the engine of **review-todo curation**: capture last report → add the relevant findings as todos → curate the subset at the request-changes gate (§19.4).

### 21.2 Todo templates (D12/D38)

- Templates are **markdown lists** — named global templates in `~/.config/agent-terminal/todo-templates/`, or external files referenced by a step (§18.6). `todoTemplate:instantiate` maps each **top-level list item** to one **active** todo (`[ ]`/`[x]` marker ignored); **nested sub-bullets and wrapped lines fold into their item**; **headings/prose are ignored** (so a template can carry a title + instructions). Reuses the flat todo model (§16.3) — no new on-disk schema; instantiation just emits `todo:add`.

---

