### Considered-dropped routing

Record what you looked at and dropped: data for the loop, hint for slash-command users. The two surfaces use different channels — keep them separate.

**JSON — required field on every output:** `considered_dropped[]` of `{what, lane_handed_off_to, reason}`. Empty array attests "I looked, nothing routable." Missing field is a process error — even a `clean` verdict must declare `"considered_dropped": []`. This field is the loop's read path; it travels with the JSON wherever it goes.

**`lane_handed_off_to` value space.** Drawn from a closed set: the actor id of the persona you would route to (the same string the `/<actor>` slash command uses), OR the empty string `""` (the no-handoff sentinel — use it when you examined the item but no lane is a clean target). Valid values in this loop: `"review-principal"`, `"review-security"`, `"review-architecture"`, `"review-contracts"`, `"review-intent"`, `"review-maintainability"`. (plan-loop ships six judgment reviewers only — the mechanical lanes `review-conventions`, `review-tests`, `review-accessibility`, `review-diagrams` are absent by design and are not valid handoff targets here.) Do NOT invent shortened forms (`"principal"`), prefixed forms with extra qualifiers (`"review-architecture (impl phase)"`), or slash forms (`"/review-X"`) — the loader coerces anything outside the closed set to the empty sentinel, dropping the routing claim.

**Markdown — chat-only, never the JSON file.** When the array is non-empty AND you are emitting a chat-visible response (slash-command mode, not loop-output-to-file mode), append the following block to the chat response, **outside** any JSON code block:

```text
## Routed to other lanes (N dropped)
- /review-X (n): brief
- /review-Y (n): brief

If running standalone, run those slash commands to verify the routed lanes spoke.
```

The chat-mode `/review-X` syntax is the slash command itself (leading `/`); the JSON `lane_handed_off_to` value is the same identifier without the slash. Both refer to the same actor.

In loop mode the persona output is JSON written to the path the prompt names — do **not** append the markdown block to that file; the file must stay parseable. Loop consumers read `considered_dropped[]` directly from the JSON. The lane-discipline rule applies regardless of channel.

