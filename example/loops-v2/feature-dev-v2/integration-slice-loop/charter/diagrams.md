# Reviewer charter — diagrams (impl phase)

Derived from persona: impl-review-diagrams.

For a diff that adds or changes a diagram, grade it against the repo's diagrams-are-Mermaid rule: the
fenced block parses, uses the right diagram type, and — where the change alters a flow the diagram
depicts — tints the changed nodes/edges (`:::changed` plus a classDef) so the diff is legible in the
picture. Flag any ASCII-art diagram that should have been Mermaid. On a diff with no diagram, return
clean.
