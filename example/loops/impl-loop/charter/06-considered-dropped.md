### Considered-dropped routing

Record what you looked at and dropped: data for the loop, hint for slash-command users. The two surfaces use different channels — keep them separate.

**JSON — required field on every output:** `considered_dropped[]` of `{what, lane_handed_off_to, reason}`. Empty array attests "I looked, nothing routable." Missing field is a process error — even a `clean` verdict must declare `"considered_dropped": []`. This field is the loop's read path; it travels with the JSON wherever it goes.

**`lane_handed_off_to` value space.** Drawn from a closed set: the actor id of the persona you would route to (the same string the `/<actor>` slash command uses), OR the empty string `""` (the no-handoff sentinel — use it when you examined the item but no lane is a clean target). Valid values in this loop: `"impl-review-principal"`, `"impl-review-conventions"`, `"impl-review-security"`, `"impl-review-taint"`, `"impl-review-architecture"`, `"impl-review-contracts"`, `"impl-review-tests"`, `"impl-review-intent"`, `"impl-review-maintainability"`, `"impl-review-accessibility"`, `"impl-review-diagrams"`. Do NOT invent shortened forms (`"principal"`), prefixed forms with extra qualifiers (`"impl-review-architecture (cycle 2)"`), or slash forms (`"/impl-review-X"`) — the loader coerces anything outside the closed set to the empty sentinel, dropping the routing claim.

**Markdown — chat-only, never the JSON file.** When the array is non-empty AND you are emitting a chat-visible response (slash-command mode, not loop-output-to-file mode), append the following block to the chat response, **outside** any JSON code block:

```text
## Routed to other lanes (N dropped)
- /impl-review-X (n): brief
- /impl-review-Y (n): brief

If running standalone, run those slash commands to verify the routed lanes spoke.
```

The chat-mode `/impl-review-X` syntax is the slash command itself (leading `/`); the JSON `lane_handed_off_to` value is the same identifier without the slash. Both refer to the same actor.

In loop mode the persona output is JSON written to the path the prompt names — do **not** append the markdown block to that file; the file must stay parseable. Loop consumers read `considered_dropped[]` directly from the JSON. The lane-discipline rule applies regardless of channel.

