# 0007. Separate transactional state from per-agent memory namespaces

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

Two very different kinds of data arise during runs. Workflow state (the current assignment, plan,
submission, scores, retry counts) is transactional and belongs to the engine for the lifetime of a
run. Agent memory (what the Coach has learned about a learner over months) is accumulated
knowledge that must outlive runs and survive agents being replaced. Mixing them in one store would
couple memory lifetime to run lifetime and let agents read each other's knowledge.

## Decision

We will keep the two apart. Workflow state is engine-owned and persisted via `StateStore` per run.
Memory is owned per agent in its own namespace within a `VectorStore`-backed memory service
(`@flowforge/memory`); an agent can only read and write its own namespace. Replacing or removing
one agent never touches another agent's memory.

## Consequences

- Namespaces form a hard isolation boundary (to be enforced by tests, not convention), which also
  gives a natural unit for inspection, deletion ("right to forget") and retention policies.
- Recall-then-prompt (RAG) is scoped and predictable: an agent's context is built only from its
  own accumulated knowledge.
- Cross-agent knowledge sharing, when needed, must be an explicit design (e.g. via workflow state
  or a shared namespace decided in the package), never an accidental leak.
- Two persistence mechanisms to operate instead of one — accepted for the ownership clarity.
