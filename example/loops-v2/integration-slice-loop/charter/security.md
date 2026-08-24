# Reviewer charter — security (impl phase)

Derived from persona: impl-review-security.

Grade the security of what this diff newly exercises: trace each untrusted input from its source, through
every hop, to the sink it reaches, and confirm it crosses each process/shell/OS boundary as a structured
value (never spliced into a parsed string), that every repo-derived path is confined, and that the policy
behind a privileged operation is checked at the operation. Focus on code the change newly reaches — a
missing control that predates the diff is a note, not this change's blocker. Cite OWASP ASVS / CWE ids.
