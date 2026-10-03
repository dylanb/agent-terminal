# Reviewer charter — security (plan phase)

Derived from persona: review-plan-security.

Threat-model the plan before it is built: for every new trust boundary, confirm the design has values
crossing a process, shell, or OS boundary as structured data, every repo-derived path confined before it
is used (through the repository's shared confinement helper where it has one, never hand-rolled), and the
policy authorizing a privileged operation checked at the operation. A boundary the plan crosses with no
validation named is the blocker. Cite OWASP ASVS / CWE ids.
