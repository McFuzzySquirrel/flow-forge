# 0006. Runtime-enforced, hash-chained audit log

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge's flagship use case marks student work. Every mark must be explainable — which prompt
version, model, evidence, rubric section, score, confidence, and any human override produced it —
and the record must be trustworthy after the fact. An optional or best-effort logging layer would
inevitably develop gaps, and a mutable log could be silently edited.

## Decision

We will make audit a runtime-enforced invariant: the agent runtime cannot execute a step without
emitting an audit record (validated by `audit-record.schema.json`) to an `AuditSink`, and human
inputs/approvals/overrides emit records through the same mechanism. The log in `@flowforge/audit`
is append-only and hash-chained: each record embeds the hash of its predecessor, so any historical
edit breaks verification of everything after it.

## Consequences

- Explainability is by construction: UIs (audit viewer, "why this mark?") only render records that
  already exist; nothing is reconstructed.
- The log is tamper-evident, not tamper-proof — detection, not prevention. Stronger guarantees
  (write-once storage, external anchoring, signing) are future work layered on the same chain.
- Every new execution path (personas, Coach/Reflection agents, Dapr runner) must preserve the
  invariant; the hash chain must verify identically across runners.
- Modest storage and write overhead per step — accepted as the cost of accountability.
