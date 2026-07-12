# 0005. Declarative workflow DSL with human-in-the-loop as first-class nodes

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

Workflows (e.g. the assignment lifecycle: teacher brief → plan → submission → marking → feedback →
approval) must be authored by package authors, pause for humans for minutes or days, survive
restarts, and eventually run on more than one engine (an embedded engine now, Dapr Workflows in
Phase 4). Imperative workflow code would tie packages to one runtime and make replay/persistence
fragile.

## Decision

We will define workflows as declarative JSON documents (validated by `workflow.schema.json`) —
a directed graph of typed nodes: `agent`, `humanInput`, `humanApproval` and `branch`, with retry
and branching as data. Human participation is a node type, not an out-of-band mechanism: a run
enters `waitingForHuman`, is persisted via `StateStore`, and resumes when the human task is
delivered. The embedded engine in `@flowforge/workflow` interprets this DSL; future runners
interpret the same documents.

## Consequences

- Runs are durable and pausable by construction; the UI only observes runs and feeds pending human
  tasks — the engine stays authoritative.
- Human approvals and overrides flow through the same node/audit machinery as agent steps, keeping
  the audit trail complete.
- The DSL is portable across runners (no imperative orchestration code to replay), which is what
  makes the Phase 4 Dapr runner and a runner-conformance suite feasible.
- Expressiveness is bounded by the schema: complex logic (e.g. rich conditions) needs deliberate
  schema extension, and the branch-condition language must stay small and safe to evaluate.
