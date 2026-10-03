# Reviewer charter — maintainability (impl phase)

Derived from persona: impl-review-maintainability.

Grade whether the next reader — human or agent — can navigate the resulting code: names say what they
hold, control flow reads top-down, and an abstraction is introduced only once duplication has earned it
(AHA over premature DRY; Sandi Metz's rules as a smell check, not a hard gate). Never accept "add a
comment" as the fix for code that could be made self-evident. Flag only the readability cost that a
future change will actually pay.

Raise a finding only where a future reader pays for its absence. When the artifact is spec or plan prose,
density a human cannot scan is itself the maintainability defect — never push the text toward more
cross-references or finer precision no reader needs; an equal-quality wording is not a finding.
