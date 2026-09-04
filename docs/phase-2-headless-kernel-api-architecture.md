# Phase 2 Headless Kernel API Architecture

This document records the **Phase 2 / Headless completeness & kernel API hardening** cut of
FlowForge. Per ADR-0011, that phase was not a UI build-out: it proved the kernel could be exercised
and persisted headlessly through stable interfaces before UI work resumed in Phase 5. The current
desktop client is documented in [phase-5-ui-architecture.md](phase-5-ui-architecture.md).

## What running this phase looked like

The primary operator surface is still terminal-first, but it is no longer just a proof harness:

1. **Validate a workforce package** with schema and graph checks.
2. **Inspect a workforce package** to see agents, skills, personas and workflows.
3. **Run workflows interactively or non-interactively** through the CLI.
4. **List persisted runs and inspect audit records** across invocations.
5. **Exercise the same kernel through the Phase 2 Electron shell** without adding new business logic.

## What this phase proved before Phase 3

Phase 2 proves the architectural claims needed for the differentiator and ecosystem work that
follows:

1. **The kernel is a transport-agnostic product surface.** `@flowforge/kernel` exposes a stable
   `KernelApi` that the CLI, Electron main process and future adapters can all share.
2. **Persistence is part of the kernel contract.** Run state, audit history and package registry can
   survive process restarts through file-backed implementations.
3. **The CLI is a real second consumer, not a one-off tool.** Features such as `runs`, `audit`,
   `memory`, `--answers` and `--watch` prove the API surface under a separate calling pattern.
4. **Authorization remains runtime-enforced (ADR-0010).** Human resumes still require an
   authenticated `Principal`; role checks and per-run participant binding stay in the engine.
5. **The Electron shell was an adapter, not the system.** It stayed buildable as a thin consumer of
   the kernel while deeper UI work was intentionally deferred to the later Phase 5 milestone by ADR-0011.

## Architecture at this phase

### Kernel contract layer

- `packages/kernel` defines `KernelApi`, snapshot types and `FlowForgeKernel`.
- The API surface covers package loading, run start/resume/query, audit access and identity
  operations without exposing transport-specific details.

This becomes the architectural centre of the product: new capabilities should land here before they
appear in any UI.

### Persistence and runtime layer

- `packages/workflow` provides file-backed run persistence through `FileStateStore`.
- `packages/audit` provides `FileAuditSink` so audit records survive restart and remain
  hash-verifiable.
- `packages/kernel` composes package registry, run index, audit sink and state store behind a
  configurable `dataDir`.
- `packages/identity` continues to own sign-in, session and role-mapping concerns separately from
  workflow state.

Phase 2 therefore turns the earlier in-memory kernel into a reusable headless application core.

### Delivery surfaces

- `packages/cli` is the reference operator surface.
- `packages/desktop` continued to use the same kernel contract through IPC; richer screens were
  intentionally deferred to the later Phase 5 milestone.

The architectural rule is now explicit: every Phase 3 and 4 capability must be exercisable via the
CLI before a richer UI is allowed to depend on it.

## Current execution paths

Two important paths exist on this branch:

1. **CLI path:** command → `FlowForgeKernel` → package/runtime/identity/audit services →
   persisted results.
2. **Desktop path:** renderer → allow-listed IPC → Electron main process → `FlowForgeKernel`.

Both paths depend on the same kernel authority for validation, workflow advancement, identity and
auditing.

## Evidence delivered in this phase

The branch already has executable proof points:

- `pnpm build`
- `pnpm test`
- `node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock --answers answers.json`
- `node packages/cli/dist/index.js runs list`
- `node packages/cli/dist/index.js audit verify`

These commands demonstrated that the kernel persisted meaningful state across invocations and that
the headless surface was complete enough to support later phases.

## Further reading

- [Phase 1 kernel architecture](phase-1-kernel-architecture.md)
- [Phase 3 differentiators architecture](phase-3-differentiators-architecture.md)
- [ADR-0011: Terminal-first development; UI layer deferred to Phase 5](adr/0011-terminal-first-ui-deferred.md)

## Constraints carried into Phase 3 and beyond

Phase 3 should preserve these properties:

- new differentiators extend `KernelApi` and kernel packages first
- the CLI remains the first-class proof surface for new capabilities
- persistence boundaries remain explicit: workflow state, audit history, memory and identity sessions
  do not collapse into one store
- authorization remains engine-owned, not caller-owned
- desktop and future clients consume kernel features but do not become the business-logic authority
