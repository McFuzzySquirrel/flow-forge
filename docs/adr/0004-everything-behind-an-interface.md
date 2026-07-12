# 0004. Swappable interfaces for model, memory, state and audit services

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge must run in very different environments: fully offline/local (mock models, in-memory
stores, a school laptop with Ollama) and hosted/cloud (OpenAI-compatible APIs, Chroma, Dapr state
stores). Packages also declare model needs per agent ("Assessment needs a strong model, Coach can
run on a small local one"), so the binding of capability to concrete backend must be a deployment
decision, not a code decision.

## Decision

We will put every external service behind a small TypeScript interface owned by the kernel:
`ModelProvider` (mock / Ollama / OpenAI-compatible), `VectorStore` (in-memory lexical / Chroma),
`StateStore` (in-memory / persistent) and `AuditSink`. Implementations are injected at composition
time; kernel and package code depend only on the interfaces. Each interface gets a shared
conformance test suite that every implementation must pass.

## Consequences

- Tests run deterministically and offline against mocks/in-memory implementations; production
  swaps in real backends with no kernel changes.
- New backends (Chroma in Phase 3, Dapr state in Phase 4) are additive packages, not rewrites.
- Interfaces must stay minimal and backend-agnostic; features that only one backend can support
  need explicit design rather than leaking through the interface.
- Slight indirection cost in code navigation — accepted for the portability gain.
