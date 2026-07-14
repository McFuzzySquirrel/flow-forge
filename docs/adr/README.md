# Architecture Decision Records

This directory holds FlowForge's Architecture Decision Records (ADRs). An ADR captures one
architecturally significant decision: the context that forced it, the decision itself, and its
consequences — so future contributors can understand *why* the system is the way it is, not just
*what* it is.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-schemas-first.md) | JSON Schemas are the source of truth for every format | Accepted |
| [0003](0003-workforce-packages.md) | All domain behaviour ships in installable workforce packages | Accepted |
| [0004](0004-everything-behind-an-interface.md) | Swappable interfaces for model, memory, state and audit services | Accepted |
| [0005](0005-declarative-workflows-human-in-the-loop.md) | Declarative workflow DSL with human-in-the-loop as first-class nodes | Accepted |
| [0006](0006-runtime-enforced-hash-chained-audit.md) | Runtime-enforced, hash-chained audit log | Accepted |
| [0007](0007-state-vs-memory-separation.md) | Separate transactional state from per-agent memory namespaces | Accepted |
| [0008](0008-pnpm-typescript-monorepo.md) | pnpm + TypeScript monorepo tooling | Accepted |
| [0009](0009-agent-skills-skill-md-format.md) | Adopt the Agent Skills SKILL.md format for skills | Accepted |

## Process

- Copy [template.md](template.md) to `NNNN-short-title.md` (next number in sequence, kebab-case title).
- Statuses: `Proposed` → `Accepted` (or `Rejected`); later `Deprecated` or `Superseded by ADR-NNNN`.
- ADRs are immutable once accepted: to change a decision, write a new ADR that supersedes the old
  one and update both statuses. Never rewrite history — the trail is the point (the same principle
  as our hash-chained audit log).
- Write an ADR whenever a decision is expensive to reverse, constrains future work, or would
  otherwise need re-explaining in every review.
