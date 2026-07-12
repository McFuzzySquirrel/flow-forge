# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge has already made several foundational decisions (schemas-first, workforce packages,
swappable interfaces, hash-chained audit) that shape everything built on top of them. Today the
rationale lives in the README's "Design rules" section and in contributors' heads. As Phases 2–4
add a desktop UI, new agents, package signing and a second workflow runner (see `docs/PLAN.md`),
future contributors will need to know *why* these constraints exist to avoid eroding them.

## Decision

We will record architecturally significant decisions as Architecture Decision Records in
`docs/adr/`, using the lightweight Michael Nygard format (Context / Decision / Consequences),
numbered sequentially and indexed in `docs/adr/README.md`. Existing foundational decisions are
backfilled as ADRs 0002–0008. Accepted ADRs are immutable; changes are made by superseding.

## Consequences

- Design intent survives contributor turnover; reviews can cite ADRs instead of re-litigating.
- Small ongoing writing cost per significant decision.
- The backfilled ADRs are written after the fact; they record the decisions as understood today.
