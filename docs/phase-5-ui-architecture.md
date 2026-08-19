# Phase 5 UI Architecture

Phase 5 is the **UI layer(s)** cut of FlowForge. Per ADR-0011, this is the point where richer
interfaces are allowed to advance again — but only as thin adapters over the kernel contract proven
through Phases 1–4.

## What this phase is for

Phase 5 turns the proven kernel into user-facing application surfaces:

1. **Electron UI completion** for package installation, run management, audit viewing and identity.
2. **A visual workflow editor** built on kernel validation rather than duplicating workflow rules.
3. **Optional mobile surfaces** that consume the same kernel contract through a different transport.

## What this phase must prove

Phase 5 is intended to prove:

1. **The UI contains no business logic.** Every meaningful user action is reproducible via the CLI
   against the same `KernelApi`.
2. **Security boundaries remain intact.** Renderer code stays untrusted; tokens and trusted
   operations remain in the main process or another trusted transport boundary.
3. **Kernel-owned validation, identity and audit rules survive UI convenience features.** The UI may
   filter or format, but it does not become the authority for package validity, authorization or
   audit integrity.
4. **The product can support more than one surface.** Electron may ship first, but the architecture
   must remain transport-agnostic enough for mobile or web later.

## Architecture at this phase

### UI boundary layer

- Untrusted renderers call an allow-listed API surface only.
- A trusted adapter process or service owns filesystem, identity tokens and kernel composition.
- `KernelApi` remains the only business-logic contract the UI is allowed to depend on.

### Electron application layer

- Package installation, workforce home, learner/teacher portals, audit viewing and admin governance
  are rendered from kernel snapshots.
- OIDC authorization-code + PKCE for interactive surfaces lands here, completing the deferred part
  of ADR-0010.

### Workflow-authoring layer

- The visual editor uses the existing package and graph validation surface from the kernel.
- Dry runs use the same runtime and mock-provider path as the CLI.

Phase 5 therefore consumes prior architectural work rather than replacing it.

## Detailed companion doc

For the currently parked Electron shell, its IPC layering, the planned page set, and the detailed
LLM integration explanation, see [Pages architecture & LLM integration](pages-architecture.md).

## Constraints within this phase

Phase 5 should preserve these properties:

- no direct kernel logic in the renderer
- no tokens or raw identity-provider internals crossing into the untrusted UI
- all package, workflow, audit and identity rules remain testable from the CLI
- future mobile/web transports wrap the same kernel contract instead of forking it
