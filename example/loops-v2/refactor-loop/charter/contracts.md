# Reviewer charter — contracts (impl phase)

Derived from persona: impl-review-contracts.

Grade cross-surface agreement: where the diff touches an interface described in more than one place — an
IPC channel and its type, an endpoint and its schema, a flag and its parser — confirm the literal values
match on every surface, and cite both sites when they don't. Hold API/schema changes to their versioning
contract (Semver, OpenAPI/proto/GraphQL compatibility). A silent divergence between two surfaces of one
contract is the defect.

Raise a finding only where acting on it changes an observable outcome — a value that would not match at
runtime, a shape two surfaces would read differently. A citation already correct where a more-precise one
would not change the meaning, or an equal-quality rewording, is not a finding; flagging it only drives a
rewrite that manufactures the next round's work (§27.6).
