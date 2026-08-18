# Changelog

All notable changes to FlowForge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- Milestone 3.3 (Chroma VectorStore adapter, namespace isolation tests, retention/decay) — in progress

---

## Phase 3 — Differentiators (Milestones 3.1, 3.2, 3.3.2, 3.4)

### Added
- **Persona enforcement (3.1):** agent runtime composes system prompts as `skill + persona overlay`; audit records now capture `personaId`; `flowforge run --persona <id>` selects a persona at run time; persona `decisionPolicy` values drive condition evaluation in the workflow engine.
- **A/B run comparison (3.1.4):** `flowforge audit show --run <a> --run <b>` diffs personas used and score deltas across two runs.
- **Coach & Reflection agents (3.2):** `coach` and `reflection` agent definitions, skills and prompts added to the `Grade7-Maths.workforce` fixture with zero platform code changes.
- **Revision workflow (3.2.2):** new `revision` workflow — Coach proposes practice steps, learner works through them, Reflection agent summarises takeaways — runs headlessly via `flowforge run … --answers`.
- **Memory-aware coaching (3.2.3):** Coach agent reads the learner memory namespace to personalise suggestions based on prior history.
- **Declarative memory write policy (3.2.4 / 3.3.2):** workflow nodes declare `memoryWrite` entries; the engine writes distilled summaries to the named namespace after each step — no code change required to configure what is remembered.
- **Graph-level workflow validation (3.4):** `validateGraph` in `@flowforge/workflow` checks reachability from `start`, dangling `next` references, and missing `default` branch conditions; exposed as `graphErrors` in `KernelApi.validatePackage`; surfaced via `flowforge validate --graph`.
- `workflow.schema.json` extended with `branch.default` constraint.

---

## Phase 2 — Headless completeness & kernel API hardening (revised per ADR-0011)

### Added
- **`@flowforge/kernel` package (2.2.1):** `KernelApi` transport-agnostic interface and `FlowForgeKernel` reference implementation; `DesktopKernel` becomes a re-export alias.
- **`FileStateStore` (2.2.2):** run state persisted as JSON files; survives process restart.
- **`FlowForgeKernel` with `dataDir` (2.2.3):** file-backed `StateStore`, `AuditSink`, package registry and run index; `FlowForgeKernel({ dataDir })` restores packages and runs across instances.
- **Persistent audit (2.2.4):** `FileAuditSink` wired into the kernel; hash chain verifies on a fresh instance; session persistence substrate ready for Phase 3 VectorStore.
- **Non-interactive run mode (2.3.1):** `flowforge run --answers <file.json>` for scripted, TTY-free CI runs.
- **`--watch` flag (2.3.2):** prints run status and node transitions as the workflow advances.
- **`flowforge runs list` / `runs show` (2.3.3):** persisted runs are inspectable across invocations.
- **`flowforge audit show` with filters (2.3.4):** `--run`, `--actor`, `--action` filtering.
- **`flowforge audit verify` (2.3.5):** hash-chain check; `exit 0` on intact chain, `exit 1` on broken.
- **`flowforge audit export` (2.3.6):** JSON export of matching audit records; re-verifiable.
- **`flowforge memory list` / `memory delete` (2.3.7):** memory inspection CLI stubs.

---

## Phase 2, Milestone 2.1 — Application shell & IPC bridge

### Added
- `packages/desktop` Electron + Vite/React application scaffold.
- Typed IPC contract (`packages/desktop/src/ipc.ts`) — request/response types shared between main and renderer; no `any` across the bridge.
- Kernel wired into the Electron main process via IPC (`validatePackage`, `loadPackage`, `startRun`, `resumeRun`, `getRun`, `getAuditTrail`).
- `contextBridge` preload with a minimal allow-listed API surface; no `nodeIntegration`.
- Dev-identity sign-in/sign-out over IPC (`signIn`, `signOut`, `getCurrentUser`); OIDC authorization-code + PKCE deferred to Phase 5.
- Desktop package integrated into root `pnpm build` / `pnpm lint` / CI.

---

## Phase 1 — Kernel

### Added
- `@flowforge/workforce-packages` — `.workforce` folder loader and cross-reference validator.
- `@flowforge/agents` — agent runtime with `MockModelProvider`, Ollama and OpenAI-compatible providers.
- `@flowforge/memory` — per-agent memory service with in-memory `VectorStore` (lexical similarity).
- `@flowforge/audit` — append-only, hash-chained audit log (`FileAuditSink` / in-memory).
- `@flowforge/workflow` — embedded workflow engine (pause/resume, retries, branching, `waitingForHuman`).
- `@flowforge/identity` — OIDC `IdentityProvider`, `MockIdentityProvider`, `RoleMapper`, `PermissionPolicy`, `SessionStore`; `WorkflowEngine.resume` requires a `Principal` with role checks and per-run participant binding (ADR-0010).
- End-to-end headless test: full Grade7-Maths `assignment` workflow with role-checked human steps.

---

## Phase 0 — Foundations

### Added
- pnpm monorepo scaffold with TypeScript project references.
- `@flowforge/core` — six JSON Schemas (`agent`, `skill`, `persona`, `workflow`, `identity`, `workforce`) and a `validate()` utility.
- `@flowforge/cli` — `flowforge validate` and `flowforge inspect` commands.
- `fixtures/Grade7-Maths.workforce` — reference workforce package (Planner, Curriculum, Assessment, Feedback, Teacher agents; assignment workflow; rubric).
- ADR index at `docs/adr/`; ADR-0010 (OIDC identity) and ADR-0011 (defer UI to Phase 5) accepted.
