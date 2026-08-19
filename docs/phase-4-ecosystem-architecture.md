# Phase 4 Ecosystem Architecture

Phase 4 is the **ecosystem** cut of FlowForge. This phase is not yet fully landed, but its
architecture is already defined by the roadmap and ADR set: workforce packages become signed,
portable artefacts; the platform is proven against a second domain; and the workflow engine is
validated against a second runner.

## What this phase is for

Phase 4 turns FlowForge from a convincing kernel into a portable platform:

1. **Package export and signing** make `.workforce` artefacts distributable and verifiable.
2. **A second domain package** proves the platform contract is genuinely domain-neutral.
3. **A Dapr-based runner** proves the workflow DSL is portable across execution substrates.

## What this phase proves before Phase 5

Phase 4 is intended to prove:

1. **Workforce packages are supply-chain artefacts, not just folders.** Deterministic archives,
   manifests and signatures make integrity and authorship testable.
2. **The package model survives a second implementation.** A Corporate-Onboarding package should run
   without education-specific logic leaking into platform code.
3. **The workflow DSL is runner-neutral.** The embedded engine and a Dapr runner should produce the
   same observable workflow behaviour and audit semantics.
4. **The kernel contract is stable enough for UI investment.** Once two packages and two runners are
   proven, Phase 5 can focus on interaction design instead of re-opening core abstractions.

## Architecture at this phase

### Package artefact layer

- CLI packaging commands build deterministic `.workforce` archives.
- Signatures and manifests sit alongside package content as install-time verification inputs.
- Compatibility metadata ensures packages and engines negotiate version expectations explicitly.

This layer extends the schema-first package boundary into distribution and governance.

### Multi-domain package layer

- `fixtures/Grade7-Maths.workforce` remains the first package.
- `fixtures/Corporate-Onboarding.workforce` is the second package used to audit for domain leaks and
  validate portability.

The key architectural test is whether new domain concepts land in package content or incorrectly
force platform changes.

### Multi-runner layer

- The embedded workflow engine becomes one `WorkflowRunner` implementation.
- A Dapr runner translates the same declarative workflow graph into durable hosted execution.
- Audit contracts remain unchanged even when state/storage adapters differ.

This is the point where "everything behind an interface" reaches the runtime substrate itself.

## Evidence expected in this phase

The roadmap defines the proof points Phase 4 should produce:

- `flowforge pack` / `flowforge unpack`
- `flowforge verify`
- two workforce packages that validate and run with zero domain-specific platform branches
- a runner-conformance suite passing against both the embedded engine and Dapr runner

## Further reading

- [Phase 3 differentiators architecture](phase-3-differentiators-architecture.md)
- [Phase 5 UI architecture](phase-5-ui-architecture.md)
- [ADR-0003: All domain behaviour ships in installable workforce packages](adr/0003-workforce-packages.md)
- [ADR-0004: Swappable interfaces for model, memory, state and audit services](adr/0004-everything-behind-an-interface.md)

## Constraints that should carry into Phase 5

Phase 5 should preserve these properties:

- UI flows install and inspect signed packages without bypassing verification rules
- multiple packages remain first-class citizens; the UI must not hardcode one domain
- runner portability remains a kernel concern, not a UI concern
- future surfaces consume the same stable kernel contract proven across Phase 4
