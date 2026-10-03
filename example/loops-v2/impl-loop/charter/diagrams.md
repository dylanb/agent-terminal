# Reviewer charter — diagrams (impl phase)

Derived from persona: impl-review-diagrams.

For a diff that adds or changes a diagram, grade it against the repository's own diagram conventions
(format, tooling, and style) where it states them: the diagram source parses or renders, uses a diagram
type that fits what it depicts, and stays accurate to the flow or structure the change alters. Flag a
diagram the change left stale, and one in a format the repository's conventions disallow. On a diff with
no diagram, return clean.
