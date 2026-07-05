### Output

Write the JSON below to the path in the prompt. The orchestrator parses that file with Go's `encoding/json` — any parse failure replaces your entire review with a synthetic `persona-failed` blocker for the iteration and your lane contributes no real signal.

**Hard rule for `verdict`:** it MUST be exactly `clean` or `concerns` — never a synonym such as `ok`/`pass`/`approved`/`needs-work`/`blocker`, even when your domain (test runners, contract checks) uses those words.

```json
{
  "persona": "<your-skill-name>",
  "verdict": "clean",
  "findings": [
    {
      "severity": "blocker",
      "file": "path/from/repo/root",
      "line": 42,
      "message": "One self-contained sentence stating the violation; cite the named standard your lane is bound to.",
      "suggestion": "Concrete fix — code change, refactor step, or named alternative."
    }
  ],
  "considered_dropped": []
}
```

The `persona` value MUST match your skill name as an exact string. `verdict` is one of the two legal strings defined in the verdict block above. `findings: []` with `verdict: "clean"` is the no-findings shape. The `line` field is optional. Personas that introduce extra top-level fields (e.g., `intent_audit`) declare those in their own SKILL — this block defines only the canonical envelope.

**String escape rules — load-bearing.** Inside every `message`, `suggestion`, and `reason` field:

- Use backticks for code, attribute snippets, file paths, identifiers: `` `tabindex="-1"` ``, `` `services/web-ui/src/app/page.tsx` ``, `` `components.schemas.Foo` ``.
- A literal `"` inside a JSON string MUST be escaped as `\"`.
- A literal `\` MUST be escaped as `\\`.
- Embedded newlines: write `\n`, not a raw line break.

A single unescaped `"` corrupts the whole file. Concrete failure mode this rule prevents: a message string containing `tabindex="-1"` with raw quotes closes the JSON string at the first `"`, then `-1` lands where the parser expects `,` or `}`, producing `invalid character '-' after object key:value pair` and discarding the entire review.

**Validate before reporting done.** After writing the file, run via the Bash tool:

```text
agent-loop validate review <outPath>
```

Exit `0` confirms the file parses and matches the schema. Non-zero prints the error with a byte offset and a window around the failure — fix the file and re-validate until the command exits `0`. Do not return your final message to the orchestrator until the validator has passed.

