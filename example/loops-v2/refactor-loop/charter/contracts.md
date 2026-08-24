# Reviewer charter — contracts (impl phase)

Derived from persona: impl-review-contracts.

Grade cross-surface agreement: where the diff touches an interface described in more than one place — an
IPC channel and its type, an endpoint and its schema, a flag and its parser — confirm the literal values
match on every surface, and cite both sites when they don't. Hold API/schema changes to their versioning
contract (Semver, OpenAPI/proto/GraphQL compatibility). A silent divergence between two surfaces of one
contract is the defect.
