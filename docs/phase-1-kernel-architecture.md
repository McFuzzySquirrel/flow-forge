# Phase 1 Kernel Architecture

This branch is the **Phase 1 / Kernel** cut of FlowForge: the headless platform is in place, the
reference workforce package runs end-to-end, and the next phase is to put a UI shell around the
kernel without changing the core rules that already work.

## What running this branch looks like

Today the runnable experience is entirely CLI-driven:

1. **Validate a workforce package** with the existing schemas and cross-reference checks.
2. **Inspect a workforce package** to see its agents, skills, personas and workflows.
3. **Run a workflow headlessly** and complete human steps through stdin prompts.

With the reference package (`fixtures/Grade7-Maths.workforce`), the flow is:

- a teacher enters an assignment brief
- the planner and curriculum agents run
- a learner submits work
- assessment, feedback and teacher-consistency agents run
- a teacher approves or rejects the mark
- the run completes with an audit trail

The current branch is therefore best understood as a **working kernel and proof harness**, not yet a
desktop product.

## What this branch proves before Phase 2

Before moving on to the vertical-slice UI, this branch already proves the critical architectural
claims:

1. **Packages, not hardcoded domain logic, define behaviour.** The platform loads agents, personas,
   skills, workflows and knowledge from a `.workforce` package and stays domain-neutral.
2. **Schemas are a real boundary.** The package can be validated before runtime, which means the
   runtime can assume well-formed data once installation/loading succeeds.
3. **Human-in-the-loop is part of the engine, not bolted on later.** Workflow runs can pause for
   human input or approval and then resume from persisted run state.
4. **Agent execution is auditable by construction.** Each agent step emits an audit record with the
   actor, action, prompt version, evidence, score/confidence where available, and hash-chain linkage.
5. **The kernel is modular enough to survive a UI phase.** Model providers, memory, workflow state
   and audit sinks are already behind interfaces, so Phase 2 can add a desktop shell without
   rewriting the core.
6. **Human actions are authenticated and role-checked (ADR-0010).** Identity is OIDC-only via
   `packages/identity`; `WorkflowEngine.resume` requires a `Principal`, verifies the pending node's
   role, binds roles to participants per run, and emits an audited
   `workflow.authorization.denied` event on failure. Packages declare roles; deployments map
   identity-provider claims to those roles via `identity.schema.json`-validated config.
7. **One end-to-end learning workflow already exists.** The Grade 7 Maths fixture is enough to prove
   the platform can orchestrate a realistic teacher → learner → agent → teacher loop.

## Architecture at this phase

### Package and schema layer

- `packages/core` defines the domain types and JSON Schemas.
- `packages/workforce-packages` loads a `.workforce` package from disk and validates both schema
  shape and cross-file references.

This is the intake boundary for the whole system: no runtime component should consume package data
that has not passed this layer.

### Kernel runtime layer

- `packages/agents` runs agent steps, assembles prompts from agent + skill + persona data, invokes a
  model provider, records audit data, and can pull supporting memory.
- `packages/workflow` interprets the declarative workflow definition, advances node by node, pauses
  on human steps, resumes with supplied responses, and tracks run state.
- `packages/memory` provides the per-agent memory namespace abstraction.
- `packages/audit` maintains the append-only, hash-chained audit trail.
- `packages/identity` provides authentication and role mapping (ADR-0010): an `IdentityProvider`
  interface with OIDC (auth-code + PKCE, device flow, refresh) and mock implementations, an
  `IdentityRegistry`, `RoleMapper`, `PermissionPolicy`, `SessionStore`, and an `IdentityService`
  that audits every login, refresh and denial.

These packages form the kernel that Phase 2 should wrap rather than replace.

### Delivery layer

- `packages/cli` is the current operator surface.
- The CLI is intentionally thin: it loads a package, wires together the runtime, and exposes
  `validate`, `inspect`, and `run`.

This means the CLI is already acting like the first adapter around the kernel. The future desktop app
should be the next adapter, not a second implementation of the runtime.

## Current execution path

The main runtime path on this branch is:

1. CLI command receives a package path and workflow id.
2. Package loader validates and loads the workforce package.
3. The CLI composes the kernel: model registry, memory service, audit log, agent runtime, workflow
   engine.
4. The workflow engine starts at the workflow's `start` node.
5. Agent nodes call the agent runtime; human nodes pause the run and return pending work.
6. A `Principal` is obtained for the pending role — from the dev identity service by default, or via
   the OIDC device flow when `--identity <config.json>` is supplied.
7. Human answers are fed back into `resume` together with the `Principal`; the engine authorizes the
   action (role check + per-run participant binding) and continues from persisted state.
8. Completion or failure is reflected in the final run status and the audit chain.

## Evidence available on this branch

The branch already has executable proof points:

- `pnpm build`
- `pnpm test`
- `node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce`
- `node packages/cli/dist/index.js inspect fixtures/Grade7-Maths.workforce`
- `node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock`

Those commands demonstrate that the monorepo builds, the kernel tests pass, the fixture package is
valid, and the reference workflow can run with interactive human pauses and a mock model provider.

## Further reading

- [Pages architecture & LLM integration](pages-architecture.md) — desktop shell layers, current
  sections, planned Phase 5 pages, and a full explanation of how LLMs are invoked and audited.

## Constraints that should carry into Phase 2

Phase 2 should preserve these properties:

- the UI renders package data rather than introducing hardcoded domain behaviour
- the workflow engine remains the single authority for run state and pause/resume behaviour
- audit generation stays runtime-enforced
- the renderer/UI is an adapter over typed interfaces, not a place where kernel logic leaks
- every human step passes through an authenticated `Principal`; the UI never bypasses the engine's
  authorization checks, and tokens/sessions stay in the trusted (main) process

If those constraints hold, Phase 2 can add user experience without weakening the architectural proof
this branch already establishes.
