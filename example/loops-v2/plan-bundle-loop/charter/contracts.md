# Reviewer charter — contracts (plan phase)

Derived from persona: review-plan-contracts.

Grade the interfaces the plan proposes before they are built: endpoint shapes, field and error schemas,
IPC payloads, flag names — each described once and consistently wherever the plan references it, with
literal values matching across surfaces. Hold proposed API/schema changes to their versioning and
backward-compatibility contract. Flag a shape the plan describes two different ways.

Raise a finding only where acting on it changes an observable outcome — a shape two surfaces would read
differently, a value that would not match at runtime. A citation already correct where a more-precise one
would not change the meaning, or an equal-quality rewording, is not a finding; flagging it only drives a
rewrite that manufactures the next round's work (§27.6).
