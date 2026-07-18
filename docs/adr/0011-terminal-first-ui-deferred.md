# ADR-0011: Terminal-first development; UI layer deferred to Phase 5

**Date:** 2026-07-15
**Status:** Accepted
**Supersedes:** the Phase 2 "Vertical Slice UI" framing in `docs/PLAN.md`

---

## Context

The original plan (Phases 2–4 in `docs/PLAN.md`) put an Electron + React desktop UI at the
centre of Phase 2 under the label "Vertical Slice UI". The intent was to prove the full journey
end-to-end with a working GUI early.

However, before this UI work was completed, the following was recognised:

1. **The UI target is undecided.** Multiple surfaces are possible and desired: Electron desktop,
   Android/iOS mobile, web. Building one UI deeply before the kernel contract is proven risks
   baking in decisions that are hard to undo across all surfaces.

2. **The CLI already exercises ~90 % of the system.** `flowforge validate`, `inspect`, and `run`
   cover package loading, workflow execution, human-input/approval steps via stdin, OIDC device
   flow for identity (terminal-native), role-checked resumes, and hash-chained audit output. The
   remaining gaps (non-interactive mode for CI, run persistence, richer audit and memory commands)
   are small and do not require a GUI.

3. **The kernel is the real asset; the UI is a transport adapter.** Milestone 2.1 correctly
   extracted an Electron-free `DesktopKernel` bridge and a typed IPC contract. Those artefacts —
   now formalised as `@flowforge/kernel` (`FlowForgeKernel` + `KernelApi`) — are the reusable
   surface. Any future UI is a thin adapter over this interface.

4. **Phases 3 and 4 are headless.** Personas, Coach/Reflection agents, Chroma memory, package
   signing, a second domain package, and the Dapr runner all prove or disprove the kernel
   contract. None require a UI to be developed or tested.

---

## Decision

**Defer the UI layer to Phase 5.** The CLI and the `KernelApi` interface are the reference
surfaces until the kernel contract is proven by at least two domain packages and two workflow
runners. All new kernel capabilities must be exercisable from the CLI before any UI work begins.

Concretely:

- **Phase 2 (revised) — Headless completeness & kernel API hardening.**
  - `@flowforge/kernel` — formal, transport-agnostic `KernelApi` interface + `FlowForgeKernel`
    reference implementation with optional file-system persistence.
  - `FlowForgeKernel` becomes the kernel used by `packages/desktop` (via `DesktopKernel`
    re-export), the CLI, and any future transport adapter.
  - CLI upgrades: `--answers <file>` non-interactive mode, `runs list/show`, `audit show/verify/export`,
    `memory list/delete`.
  - `FileStateStore` (workflow package) and `FileAuditSink` (already in audit package) enable
    run and audit persistence across CLI invocations.
  - `packages/desktop` is kept building/green; no new Electron screens are added.

- **Phase 3 — Differentiators, headless.** Personas (3.1), Coach/Reflection (3.2), Chroma memory
  (3.3) — "Done when" criteria changed from "in the UI" to "headlessly via CLI + tests".
  Graph-level workflow validation (`flowforge validate --graph`) replaces the visual-editor work;
  the full visual editor moves to Phase 5.

- **Phase 4 — Ecosystem (unchanged).** Package signing, Corporate-Onboarding second package,
  Dapr conformance suite — all terminal-testable, all proving the kernel contract.

- **Phase 5 (new) — UI layer(s).** Electron-first (because Milestone 2.1 is already partially
  built), mobile later. Exit criterion: **the UI contains zero business logic** — every user
  action is reproducible via the CLI against the same `KernelApi`.

- **Identity (cross-phase):** I.6 (OIDC authorization-code + PKCE) moves to Phase 5; the OIDC
  device flow (already shipped) is sufficient for terminal use. I.7 (persistent `SessionStore`)
  moves to Phase 2.

---

## Consequences

**Positive:**
- The kernel contract is proven by independent consumers (CLI + tests) before any UI bets are
  placed. Switching from Electron to a web or mobile surface requires writing a new adapter, not
  refactoring business logic.
- Every new capability is CI-testable without a headless browser or Electron test harness.
- Phase 3–4 work is unblocked: it never depended on the UI, and it no longer needs to wait for
  Phase 2 UI screens to land.
- The `KernelApi` interface is the living specification for what any UI must be able to do; it
  evolves through Phase 3–4 before UI work starts.

**Negative / trade-offs:**
- No demo-friendly GUI until Phase 5. The existing Phase 2.1 Electron shell (package load +
  run + audit) remains runnable as a demo but will not be extended.
- Some UI requirements surface only when building real UIs (pagination, optimistic updates,
  event granularity). The event-subscription API (a future `KernelApi` extension) should be
  designed with a UI consumer in mind, even while the CLI is its first client.
- The `packages/desktop` package carries a dependency on `@flowforge/kernel` and will build but
  sit idle. This is acceptable overhead.

---

## Related ADRs

- [ADR-0004](0004-everything-behind-an-interface.md) — swappable interfaces: this ADR is the
  logical extension of "everything behind an interface" to the kernel itself.
- [ADR-0010](0010-oidc-identity-and-role-based-authorization.md) — identity: the terminal-first
  approach relies on OIDC device flow; PKCE for desktop deferred to Phase 5.
