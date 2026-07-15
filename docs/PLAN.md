# FlowForge Build Plan — Phases 2–5

This is the detailed working plan for the next phases of FlowForge. It breaks each phase into
milestones and tasks, and every milestone includes a **📚 Learn while you build** section that
explains the concepts, patterns and trade-offs involved — so the plan doubles as a learning
companion.

**Where we are:** Phase 0 (Foundations) and Phase 1 (Kernel) are complete. The monorepo builds
(`pnpm build`), tests pass (`pnpm test`), and the CLI can validate, inspect and headlessly run the
`Grade7-Maths.workforce` reference package with the mock model provider. The identity kernel
(ADR-0010) has also landed: `packages/identity` provides OIDC sign-in, claim-to-role mapping and
sessions, and `WorkflowEngine.resume` now requires an authenticated `Principal` with role checks
and per-run participant binding (tasks I.1–I.5 below).

**Phase 2 is now revised (see ADR-0011).** The original "Vertical Slice UI" phase has been
replaced by **Headless completeness & kernel API hardening**. The decision: defer all UI work to
Phase 5, prove the kernel contract first through the CLI and two domain packages. Milestone 2.1
(application shell & IPC bridge) has already landed as a foundation for the eventual UI:
`packages/desktop` is an Electron + Vite/React app with a typed IPC contract (`src/ipc.ts`), an
Electron-free kernel bridge (`src/kernel.ts` — now delegating to `@flowforge/kernel`), a
`contextBridge` preload with no `nodeIntegration`, and dev-identity sign-in. The desktop package
remains buildable but receives no new screens until Phase 5. **Next up is completing Milestone 2.2**
(persistent package registry and run persistence) and the remaining CLI upgrades (2.3).

**Try the current slice:** after `pnpm install && pnpm build`:
- `flowforge validate fixtures/Grade7-Maths.workforce` — validate the reference package
- `flowforge inspect fixtures/Grade7-Maths.workforce` — show agents, skills, workflows
- `flowforge run fixtures/Grade7-Maths.workforce assignment --mock` — interactive run via stdin
- `flowforge run fixtures/Grade7-Maths.workforce assignment --mock --answers answers.json` — non-interactive CI run
- `flowforge runs list` — list persisted runs (from `~/.flowforge`)
- `flowforge audit show` — view audit records; `audit verify` checks chain integrity

**Try the current slice:** after `pnpm install && pnpm build`, run
`pnpm --filter @flowforge/desktop dev` to open the desktop shell. Enter the path to
`fixtures/Grade7-Maths.workforce`, load it, sign in as a role (e.g. `teacher` or `learner`), start
the `assignment` workflow, answer the human-input/approval steps, and watch the audit trail update.
An unauthorized action (e.g. a learner approving) surfaces as an audited denial.

**Design rules that govern everything below** (see README):

1. Schemas first — nothing consumes a format without a validating schema.
2. Everything behind an interface — `ModelProvider`, `VectorStore`, `StateStore`, `AuditSink` are swappable.
3. No hardcoded agents — all behaviour comes from `.workforce` packages.
4. Audit is runtime-enforced — every agent step emits an immutable, hash-chained audit record.
5. Human actions are authenticated and role-checked (ADR-0010) — every surface that resumes a run
   must supply a `Principal`; the engine, not the UI, is the authorization authority.

---

## Phase 2 — Headless completeness & kernel API hardening *(revised — ADR-0011)*

**Goal:** prove the whole system works in a terminal before committing to any UI target. Every
feature from the original Phase 2 UI that is actually a kernel concern lands here, exercised
through the CLI and its test suite. The Electron shell stays buildable but receives no new screens.

### Milestone 2.1 — Application shell & IPC bridge ✔ (landed; parked)

| # | Task | Done when |
| --- | --- | --- |
| 2.1.1 | Scaffold `packages/desktop` (Electron main process + Vite/React renderer) in the pnpm workspace | `pnpm --filter @flowforge/desktop dev` opens an empty window ✔ |
| 2.1.2 | Define a typed IPC contract (`packages/desktop/src/ipc.ts`) — request/response types shared between main and renderer | Renderer calls are fully typed; no `any` crosses the bridge ✔ |
| 2.1.3 | Wire the kernel into the main process: expose `validatePackage`, `loadPackage`, `startRun`, `resumeRun`, `getRun`, `getAuditTrail` over IPC | Renderer can list a loaded package's agents/workflows ✔ |
| 2.1.4 | Add a `contextBridge` preload with a minimal, allow-listed API surface (no `nodeIntegration`) | Security checklist passes: renderer has no direct Node access ✔ |
| 2.1.5 | Add desktop package to root `pnpm build` / `pnpm lint` / CI | Fresh clone builds everything with one command ✔ |
| 2.1.6 | Identity (I.6, dev-identity slice): `signIn`, `signOut`, `getCurrentUser` over IPC using dev identity | Dev-identity slice shipped ✔; OIDC authorization-code + PKCE deferred to Phase 5 (ADR-0011) |

### Milestone 2.2 — Formal `KernelApi` & persistence

| # | Task | Done when |
| --- | --- | --- |
| 2.2.1 | Extract `@flowforge/kernel`: `KernelApi` interface (transport-agnostic snapshot types + method signatures) and `FlowForgeKernel` reference implementation | All existing `DesktopKernel` tests pass against `FlowForgeKernel`; `DesktopKernel` is a re-export alias ✔ |
| 2.2.2 | `FileStateStore` in `@flowforge/workflow` — persist individual run state as JSON files | Run state survives process restart ✔ |
| 2.2.3 | `FlowForgeKernel` with optional `dataDir`: file-backed `StateStore`, `AuditSink`, package registry and run index | `FlowForgeKernel({ dataDir })` restores packages and runs from disk across instances ✔ |
| 2.2.4 | Identity (I.7): `FlowForgeKernel` wires `FileAuditSink` so audit records persist; session persistence substrate ready for Phase 3 VectorStore work | Audit log survives restart; chain verifies on a fresh kernel instance ✔ |

### Milestone 2.3 — CLI completeness

| # | Task | Done when |
| --- | --- | --- |
| 2.3.1 | `--answers <file.json>` non-interactive mode for `flowforge run` — ordered list of scripted responses | Full Grade7-Maths assignment workflow runs in CI with no TTY ✔ |
| 2.3.2 | `--watch` flag: prints run status and node transitions as the workflow advances | Progress is observable from a terminal without polling ✔ |
| 2.3.3 | `flowforge runs list [--package <id>]` and `flowforge runs show <run-id>` | Persisted runs are inspectable across invocations ✔ |
| 2.3.4 | `flowforge audit show [--run <id>] [--actor <id>] [--action <action>]` — filtered audit view | Operator can trace any human action in a run ✔ |
| 2.3.5 | `flowforge audit verify` — hash-chain check as a standalone command | `exit 0` on intact chain; `exit 1` if broken (CI-friendly) ✔ |
| 2.3.6 | `flowforge audit export [--run <id>] [--output <file>]` — JSON export | Exported file contains all matching records; can be re-verified with `audit verify` ✔ |
| 2.3.7 | `flowforge memory list <namespace>` / `flowforge memory delete <namespace> <id>` — memory inspection CLI stubs | Commands are wired; full persistence follows Chroma adapter in Milestone 3.3 ✔ |

**📚 Learn while you build — interface-first design & the second consumer rule**

- The `KernelApi` interface is transport-agnostic because it contains only **plain types** —
  no class instances, no callbacks, no Node.js-specific objects. Any transport (Electron IPC,
  HTTP, Unix socket, direct function call from the CLI) can wrap an instance of `FlowForgeKernel`
  by translating its channel protocol to these method signatures. This is the same principle as
  designing an API spec before writing the server.
- The CLI is the **second consumer** of the kernel (the Electron main process was the first). You
  only know an abstraction is right when it has two consumers. The CLI will surface any rough edges
  in the `KernelApi` surface before any UI investment is made — this is the second-implementation
  rule in practice.
- `FileStateStore` and `FileAuditSink` are the persistence layer the kernel needed all along; it
  just wasn't visible until the CLI's `runs list` command needed to read state from a previous
  invocation. **Making a capability terminal-testable forces you to design it correctly.**

### Phase 2 exit criteria

- `pnpm test` passes; `FlowForgeKernel` tests cover both in-memory and file-backed persistence.
- The full Grade7-Maths assignment workflow runs end-to-end in CI via `--answers` (no TTY, no
  interactive prompt).
- `flowforge runs list` shows runs from a previous invocation; `flowforge audit verify` exits 0.
- `packages/desktop` still builds and its existing tests still pass; no new Electron screens added.
- The `KernelApi` interface is the stable contract that Phase 3–4 features will extend.

---
  explicit API. This is the *principle of least privilege* applied to a desktop app.
- Defining the IPC contract as shared TypeScript types is the same idea as an API schema
  (OpenAPI/gRPC): one source of truth for both sides. Notice how this mirrors FlowForge's own
  "schemas first" rule.

### Milestone 2.2 — Package installation & workforce home

| # | Task | Done when |
| --- | --- | --- |
| 2.2.1 | "Install package" flow: pick a `.workforce` folder, run the existing validator, show validation errors inline | Invalid package shows schema errors; valid package installs |
| 2.2.2 | Workforce home screen: branding, agent roster (role, skills, persona, model tier), workflow list — all rendered from package data | Nothing on screen is hardcoded; swapping the fixture package changes the UI |
| 2.2.3 | Installed-package registry persisted to app data (list, remove, re-validate on launch) | Packages survive app restart |
| 2.2.4 | Agent detail view: skills, persona summary, permissions, memory namespace | Every field traces back to a schema-validated file |

**📚 Learn while you build — data-driven UI**

- This milestone is the UI expression of design rule 3 (*no hardcoded agents*). The screen is a
  pure function of package data: `UI = render(package)`. This is the same philosophy as React
  itself (`UI = f(state)`), applied one level up.
- Re-validating on launch teaches an important distinction: **validate at the boundary, then
  trust**. We validate at install/launch so everything downstream can assume well-formed data.
  The JSON Schemas in `packages/core/schemas/` are that boundary.

### Milestone 2.3 — Teacher portal: run a workflow

| # | Task | Done when |
| --- | --- | --- |
| 2.3.1 | "Start workflow" screen: choose workflow, choose model provider (mock/Ollama/OpenAI-compatible) per model tier | A run starts and appears in a run list |
| 2.3.2 | Run view: live node-by-node progress (which agent is working, which node is `waitingForHuman`) | Status updates without manual refresh |
| 2.3.3 | Human-input node UI: render the node's `prompt`, collect the teacher's answer, resume the run with the signed-in teacher's `Principal` | The `create-assignment` step of the assignment workflow works end-to-end |
| 2.3.4 | Human-approval node UI: show the `subject` (e.g. proposed marks), approve / reject with reason, resuming with the approver's `Principal` | Rejection reason lands in workflow state and the audit trail |
| 2.3.5 | Retry/failure surfacing: show attempt counts and terminal failures with the error; surface `workflow.authorization.denied` (wrong role / wrong participant) as a distinct, readable card | A failing mock provider produces a readable failure card; an unauthorized resume shows who was denied and why |

**📚 Learn while you build — human-in-the-loop workflow engines**

- The workflow engine (Phase 1) is a small **state machine**: a run has a status (`running`,
  `waitingForHuman`, `completed`, `failed`), a current node, and a state bag. The UI never drives
  the workflow — it only *observes* runs and *feeds* pending human tasks. Keeping the engine
  authoritative avoids split-brain bugs.
- `waitingForHuman` is the key idea of **durable, pausable execution**: the run is persisted via
  `StateStore` and can resume minutes or days later. Big workflow systems (Temporal, Dapr
  Workflows, Step Functions) are built on exactly this pause/resume-from-persisted-state model —
  which is why Phase 4's Dapr runner is feasible.
- Notice that *human approval is just another node type*, not a special case bolted on. Modelling
  humans as first-class workflow participants is what makes the audit story coherent: overrides are
  recorded like any other step.

### Milestone 2.4 — Learner portal

| # | Task | Done when |
| --- | --- | --- |
| 2.4.1 | Portals keyed to the signed-in identity: the learner portal shows only human tasks whose node `role` maps to one of the current `Principal`'s roles (dev identity provides one user per role locally; real users come from the configured OIDC provider) | Portals show only the human tasks for the signed-in user's roles; switching users switches portals |
| 2.4.2 | Learner task inbox: pending `humanInput` nodes where `role == "learner"` (e.g. "submit your work") | Submitting resumes the run with the learner's `Principal`; per-run participant binding means only the learner who submitted may resubmit |
| 2.4.3 | Feedback view: rendered feedback + score once the workflow completes, with "why?" linking to audit records | Learner can see evidence and rubric section behind their mark |

**📚 Learn while you build — roles and authorisation**

- Filtering tasks by the node's `role` field is **role-based access control (RBAC)**. Since
  ADR-0010 the kernel enforces it for real: the engine checks the `Principal`'s roles and per-run
  participant bindings on every resume, so the portal filter is a *convenience*, not the security
  boundary. The lesson: separate *authentication* (who are you — `packages/identity`) from
  *authorisation* (what may you do — the workflow engine); the UI must never re-implement either.
- The "why?" link is **explainability by construction**: because audit is runtime-enforced (design
  rule 4), the UI never has to reconstruct an explanation — it just renders records that already exist.
  These CLI audit commands are that explainability surface in terminal form.

---

## Phase 3 — Differentiators *(now headless — ADR-0011)*

**Goal:** the features that make FlowForge more than a workflow runner — personas that change
behaviour, agents that coach and reflect, memory that genuinely accumulates, and graph-level
workflow validation. "Done when" criteria now target the CLI and tests, not the UI; the UI
expression of each feature ships in Phase 5.

### Milestone 3.1 — Persona enforcement

| # | Task | Done when |
| --- | --- | --- |
| 3.1.1 | Extend the agent runtime to compose system prompts as *capability (skill) + persona overlay*, with the persona layer clearly delimited | Prompt assembly is unit-tested; audit records capture persona id + version |
| 3.1.2 | Persona selection in `flowforge run` via `--persona <id>` flag per agent node | Same Assessment agent runs as "Supportive Mentor" vs "Strict Examiner" with visibly different feedback |
| 3.1.3 | Persona decision-policy hooks: thresholds/settings a persona can adjust (e.g. strictness affects approval routing), schema-validated | Policy values come from `persona.schema.json`-validated data, not code |
| 3.1.4 | A/B run comparison: `flowforge audit show --run <a> --run <b>` diffs two runs' audit trails | CLI output shows personas used and score deltas between runs |

**📚 Learn while you build — prompt layering & separation of concerns**

- Persona-on-top-of-skill is **separation of concerns** applied to prompts: *what the agent can do*
  (capability) vs *how it behaves* (style/policy). Keeping the layers separate means you can swap
  either independently — the same reason we keep state and memory separate.
- Recording prompt version + persona in every audit record makes behaviour **reproducible**: you
  can explain a mark by pointing at exactly which persona and prompt produced it. This is prompt
  engineering treated as configuration management.

### Milestone 3.2 — Coach & Reflection agents

| # | Task | Done when |
| --- | --- | --- |
| 3.2.1 | Add Coach and Reflection agent definitions, skills and prompts to the Grade7-Maths fixture (platform code unchanged) | `flowforge validate` passes; agents appear in the roster with zero code changes |
| 3.2.2 | New `revision` workflow: after feedback, Coach proposes practice steps; learner works through them; Reflection agent summarises what the learner should internalise | Workflow runs headlessly via CLI (`--answers`) with zero code changes |
| 3.2.3 | Coach reads the learner-relevant memory namespace to personalise suggestions ("you struggled with fractions last time") | Suggestions demonstrably change based on stored memory |
| 3.2.4 | Reflection agent writes distilled takeaways back to memory (not raw transcripts) | Memory grows with summaries, not noise |

**📚 Learn while you build — multi-agent design & the reflection pattern**

- Coach/Reflection are examples of **agent specialisation**: instead of one mega-prompt, small
  agents with narrow jobs compose via the workflow. Narrow agents are easier to test, audit and
  swap — the same argument as microservices vs monolith, with the same trade-off (more moving
  parts, orchestration required).
- The Reflection agent implements the **reflection pattern** from agentic-AI literature: a step
  that reviews outcomes and distils lessons. Writing *summaries* rather than transcripts into
  memory is deliberate — retrieval quality degrades when the store is full of low-signal text
  (garbage in, garbage out applies to vector stores too).
- Adding both agents *without touching platform code* is the proof of design rule 3. If you find
  yourself editing `packages/agents` to make Coach work, stop — the package format is missing a
  capability, and the fix belongs in the schema.

### Milestone 3.3 — Long-term memory in anger

| # | Task | Done when |
| --- | --- | --- |
| 3.3.1 | Chroma (or equivalent) `VectorStore` adapter implementing the existing interface, with real embeddings via a `ModelProvider`-style embedding abstraction | In-memory and Chroma adapters pass the same interface test suite |
| 3.3.2 | Memory write policy: what gets remembered after each workflow (per-agent, declared in the package) | Memory writes are declarative package config, not code |
| 3.3.3 | Memory inspector UI: browse a namespace, see items + metadata, delete items ("right to forget") | Deleting an item verifiably removes it from recall |
| 3.3.4 | Namespace isolation tests: agent A can never recall agent B's memory; replacing an agent preserves others' memory | Isolation is enforced by tests, not convention |
| 3.3.5 | Retention/decay knobs (max items, age-out) configurable per namespace | Old memory ages out per config |

**📚 Learn while you build — vector search & RAG**

- **Embeddings** map text to points in high-dimensional space where semantic similarity ≈
  geometric closeness. **Vector search** finds nearest neighbours; the current in-memory store
  fakes this with lexical (token-overlap) similarity — good enough for tests, wrong for real
  recall. Swapping to real embeddings behind the same `VectorStore` interface is design rule 2
  paying off.
- Recall-then-prompt is **RAG** (retrieval-augmented generation): fetch the most relevant memories,
  inject them into the agent's context. Key practical lessons: retrieval quality depends on what
  you *stored* (hence 3.2.4), `limit` matters (context windows are finite), and irrelevant recalls
  actively harm output.
- Per-agent **namespaces** are a data-isolation boundary, like schemas in a database. The
  "replace one agent, keep others' memory" property only holds because memory is owned per
  namespace, not per workflow — this is the state-vs-memory distinction from the README made real.

### Milestone 3.4 — Graph-level workflow validation *(visual editor deferred to Phase 5)*

The graph-level validation logic is needed by any future editor, so it belongs in the kernel now.
The visual editor itself ships in Phase 5.

| # | Task | Done when |
| --- | --- | --- |
| 3.4.1 | Graph-level checks in `flowforge validate --graph`: reachability from `start` (all nodes reachable), no dangling `next` references, every branch has a `default` condition | Invalid workflows are caught before `run`; exit code 1 on failure |
| 3.4.2 | Expose graph validation in `KernelApi.validatePackage` result (add `graphErrors` field) | Any consumer (CLI, future UI) gets graph errors alongside schema errors |

**📚 Learn while you build — DSLs, graphs and static analysis**

- The workflow JSON is a **declarative DSL** (domain-specific language): it says *what* happens,
  not *how*. Graph-level validation is **static analysis** over that DSL — the same job a compiler's
  semantic phase does after the syntax (schema) check. Reachability from `start` is BFS/DFS;
  detecting dangling edges is a simple set-difference; branch defaults are a rules check.
- Layering validation — JSON Schema (shape) then graph checks (semantics) — mirrors how compilers
  work: syntax first, then semantic analysis. Exposing both in `KernelApi` means the future visual
  editor gets graph errors for free without re-implementing the checks.

### Phase 3 exit criteria

- Persona switch demonstrably changes agent behaviour, with the persona recorded in audit.
- Coach/Reflection revision workflow runs end-to-end via `flowforge run --answers`; memory measurably influences coaching.
- Chroma-backed memory passes the shared `VectorStore` test suite.
- `flowforge validate --graph` catches unreachable nodes and dangling edges; exit code is CI-friendly.

---

## Phase 4 — Ecosystem

**Goal:** make workforce packages a real ecosystem artefact — exportable, signed, provably
domain-agnostic (second package), and runnable on production-grade infrastructure (Dapr Workflows).

### Milestone 4.1 — Package export & signing

| # | Task | Done when |
| --- | --- | --- |
| 4.1.1 | Canonical archive format: `.workforce` as a deterministic zip (stable file order, normalised metadata) with a manifest of file hashes | Building twice from the same source yields identical bytes |
| 4.1.2 | `flowforge pack` / `flowforge unpack` CLI commands | Round-trip preserves package content exactly |
| 4.1.3 | Signing: generate a keypair, sign the manifest (Ed25519), embed signature + public key fingerprint | `flowforge verify` proves integrity + authorship |
| 4.1.4 | Install-time verification in the desktop app: show signer, warn on unsigned, refuse on invalid signature | Tampered package is rejected with a clear message |
| 4.1.5 | Version & compatibility metadata: package `engineVersion` range checked at install | Old engine refuses a too-new package gracefully |

**📚 Learn while you build — supply-chain security & deterministic builds**

- Hash manifest + signature is the standard **software supply chain** pattern (npm provenance,
  Sigstore, Debian packages): the *hash* proves integrity (nothing changed), the *signature* proves
  authenticity (who published it). Note what it does **not** prove: that the content is *good* —
  signing is not review.
- **Deterministic (reproducible) builds** matter because signatures are over bytes: if zipping the
  same source can produce different bytes (timestamps, file order), verification becomes flaky and
  "did it change?" becomes unanswerable. Normalising inputs before hashing is the fix.
- **Ed25519** is a modern signature scheme: small keys, fast, no parameter foot-guns — the default
  choice for exactly this kind of artefact signing.

### Milestone 4.2 — Second domain package: Corporate-Onboarding

| # | Task | Done when |
| --- | --- | --- |
| 4.2.1 | Author `fixtures/Corporate-Onboarding.workforce`: HR-Planner, Buddy, Compliance, Manager-Review agents; onboarding workflow with human approvals | Validates and runs headlessly with zero platform changes |
| 4.2.2 | Domain-language audit: hunt for education-specific assumptions that leaked into platform code or schemas (e.g. "rubric", "teacher" hardcoded anywhere outside packages) | Grep-level audit is clean or fixes are made schema-side |
| 4.2.3 | Run both packages side by side via `flowforge run` and verify isolated memory and audit | Two packages, two isolated audit chains, zero cross-contamination |
| 4.2.4 | Write a "package author guide" (`docs/authoring-packages.md`) distilled from building the second package | A newcomer can scaffold a third package from the guide |

**📚 Learn while you build — the second-implementation rule**

- You never know an abstraction is right until it has **two consumers**. The first package
  *defines* the format; the second one *tests* it. Expect to find leaks — every generic platform
  does. The discipline is fixing them in the schema/package layer, never with `if (domain === ...)`
  in platform code.
- This is the platform-vs-product distinction: Grade7-Maths is a *product* built on the FlowForge
  *platform*. Writing the authoring guide forces you to articulate the platform's contract — if
  it's hard to document, it's hard to use.

### Milestone 4.3 — Dapr Workflows runner

| # | Task | Done when |
| --- | --- | --- |
| 4.3.1 | Extract a `WorkflowRunner` interface from the embedded engine (start, resume, query, deliver-human-task) so the engine becomes one implementation | Embedded engine passes a runner-conformance test suite |
| 4.3.2 | Dapr runner package: translate `workflow.schema.json` nodes to Dapr Workflow activities; human nodes become Dapr external-event waits | Assignment workflow runs on Dapr with the same observable behaviour |
| 4.3.3 | State & audit adapters for the hosted context (Dapr state store; `AuditSink` unchanged in contract) | Hash chain verifies identically on both runners |
| 4.3.4 | Docker Compose dev environment (Dapr sidecar, Redis, Chroma) + docs | `docker compose up` gives a working hosted stack |
| 4.3.5 | Conformance suite run against both runners in CI | One spec, two runners, same results |

**📚 Learn while you build — durable execution & portability**

- **Dapr Workflows** implements *durable execution*: workflow code replays from an event history
  after crashes, so activities must be **deterministic** and side effects live in activities, not
  orchestrator logic. Our declarative JSON avoids the classic replay pitfalls (no random/now/IO in
  orchestration code) almost by construction — a payoff of choosing a DSL over imperative
  workflow code.
- Human-in-the-loop maps to Dapr's **external events**: the workflow parks (consuming no compute)
  until an event arrives — the hosted-scale version of our `waitingForHuman` status. Same concept,
  different persistence substrate.
- The runner-conformance suite is the key engineering artefact here: **one spec, N runners** is how
  you keep portability honest (compare: the JVM spec, or SQL conformance tests). Design rule 2
  ("everything behind an interface") reaches its final form in this milestone.

### Phase 4 exit criteria

- `flowforge pack`/`verify` round-trips a signed package; tampered packages are rejected.
- Corporate-Onboarding runs with zero platform changes; authoring guide published.
- Assignment workflow passes the conformance suite on both the embedded and Dapr runners.
- The `KernelApi` is considered stable: two packages proven, two runners proven, CLI as reference surface.

---

## Phase 5 — UI layer(s) *(new — ADR-0011)*

**Goal:** thin UI clients over the frozen `KernelApi`. The kernel contains all business logic;
the UI is a rendering and interaction layer only. Exit criterion: **every user action in the UI
is reproducible via the CLI against the same `KernelApi`.**

### Milestone 5.1 — Electron application (completing Milestone 2.2–2.5 from the original plan)

| # | Task | Done when |
| --- | --- | --- |
| 5.1.1 | "Install package" flow: pick a `.workforce` folder, run the validator, show schema and graph errors inline | Invalid package shows all errors; valid package installs and appears in the home screen |
| 5.1.2 | Workforce home screen: branding, agent roster, workflow list — all rendered from `KernelApi.listPackages()` data | Swapping the fixture package changes the UI; nothing is hardcoded |
| 5.1.3 | Installed-package registry persisted (backed by `FlowForgeKernel` dataDir already shipped in Phase 2) | Packages survive app restart |
| 5.1.4 | Teacher portal: start workflow, live run progress, human-input and human-approval nodes, failure surfacing | Full Grade7-Maths assignment workflow works end-to-end in the UI |
| 5.1.5 | Learner portal: task inbox filtered by the signed-in user's roles; feedback view with audit "why?" links | Role filtering is a convenience; the kernel enforces it for real |
| 5.1.6 | Audit viewer: chronological records, hash-chain verify button, filter and JSON export | `audit verify` in the UI matches `flowforge audit verify` result |
| 5.1.7 | Identity (I.6): OIDC authorization-code + PKCE for the desktop app (completing Task 2.1.6) | UI shows the signed-in user from a real OIDC provider; tokens never cross IPC |
| 5.1.8 | Admin governance UI (I.8): role-mapping management, session policy, per-user audit trail | Admin can review who did what, as which role, asserted by which provider |

### Milestone 5.2 — Visual workflow editor

| # | Task | Done when |
| --- | --- | --- |
| 5.2.1 | Read-only workflow diagram (React Flow or similar) — renders any `workflow.schema.json` as a node graph | The assignment workflow renders correctly, branches included |
| 5.2.2 | Live run overlay: highlight current node, completed path, pending human task on the diagram | Watching a run animates the graph |
| 5.2.3 | Editing: add/remove/connect nodes; node property panels per node type | Edits round-trip: load → edit → save produces valid JSON |
| 5.2.4 | Continuous validation using `KernelApi.validatePackage` (schema + graph errors already shipped in Phase 3) | Invalid graphs cannot be saved silently |
| 5.2.5 | "Dry run" button: execute the edited workflow with the mock provider from inside the editor | Author → test loop without leaving the editor |

### Milestone 5.3 — Mobile (Android / iOS) — if pursued

| # | Task | Done when |
| --- | --- | --- |
| 5.3.1 | Define a transport adapter for the mobile target (HTTP/WebSocket to a local kernel server or remote) | Mobile client calls `KernelApi` over the chosen transport |
| 5.3.2 | Learner-focused mobile UI: task inbox, human-input and human-approval forms, feedback view | Learner can complete their workflow steps from a phone |

**📚 Learn while you build — thin clients & the zero-business-logic rule**

- The exit criterion — *every user action is reproducible via the CLI* — is the test of whether
  the UI is truly thin. If you find yourself adding logic to the renderer that is not in
  `FlowForgeKernel`, it belongs in the kernel, not the UI.
- Mobile vs Electron vs web is a **transport adapter** problem, not a business logic problem. The
  `KernelApi` interface is the same; only the IPC mechanism differs. Phase 5's value is in proving
  this claim with at least two UI surfaces.

### Phase 5 exit criteria

- Grade7-Maths assignment workflow runs end-to-end in the Electron UI with real OIDC identity.
- Audit trail in the UI matches `flowforge audit show` output exactly.
- The visual editor can author a valid workflow that then runs via `flowforge run`.
- Zero business logic in the renderer: every action has a corresponding CLI test.

---

## Cross-phase — Identity & Governance (ADR-0010)

**Goal:** authenticated, role-checked human actions across every surface, with any OIDC-compliant
identity provider (Microsoft Entra ID, Google Workspace for Education, Auth0, Keycloak).

Shipped in the kernel (Phase 0/1 slice):

| # | Task | Done when |
| --- | --- | --- |
| I.1 | ADR-0010 settles the identity architecture (OIDC-only; dedicated session store; RBAC + per-run participant binding; packages declare roles, deployments map claims) | ADR accepted and indexed ✔ |
| I.2 | `identity.schema.json` in `packages/core/schemas` — providers, claim-to-role mappings, role permissions, session policy | Config validates via `validate('identity', …)` with tests ✔ |
| I.3 | `packages/identity` — `IdentityProvider` interface, `OidcIdentityProvider` (auth-code + PKCE, device flow, refresh, userinfo), `MockIdentityProvider`, `IdentityRegistry`, `RoleMapper`, `PermissionPolicy`, `SessionStore`, `IdentityService` with audited auth events | Unit tests cover claim mapping, sessions, audited login/refresh/denial ✔ |
| I.4 | Engine enforcement — `WorkflowEngine.resume` requires a `Principal`, checks the node role, binds roles per run, audits `workflow.authorization.denied` | Grade7-Maths tests prove a student cannot approve and a teacher cannot submit student work ✔ |
| I.5 | CLI wiring — dev identity by default; `--identity <config.json>` signs users in via the OIDC device flow | `flowforge run … --identity` completes a device-flow login ✔ |

Follow-up work (slotted into the phases above):

| # | Task | Done when |
| --- | --- | --- |
| I.6 | Desktop app login via authorization-code + PKCE (Phase 5, Task 5.1.7) | UI shows the signed-in user; every human step passes the Principal |
| I.7 | Persistent `SessionStore` (Phase 2: `FileAuditSink` + kernel dataDir shipped; full cross-process session persistence follows Phase 3 VectorStore work) | Sessions survive restart; revocation works across nodes |
| I.8 | Admin governance UI — role-mapping management, session policy, per-user audit trail (Phase 5, Task 5.1.8) | Admin can review who did what, as which role, asserted by which provider |

---

## Suggested build order & dependencies

```
Phase 2:  2.1 (done) → 2.2 → 2.3  (sequential; each builds on the last)
Phase 3:  3.1 and 3.3 can start in parallel; 3.2 depends on 3.3.1 (real recall);
          3.4 (graph validation) is independent of 3.1–3.3
Phase 4:  4.1 and 4.2 can start in parallel; 4.3 last (benefits from a hardened schema after 4.2)
Phase 5:  after Phase 4 exit criteria are met; 5.1 and 5.2 can proceed in parallel within the phase
```

Working agreement for every task: schema changes land first with validator tests; kernel changes
ship with unit tests; CLI changes ship with a headless end-to-end test (`--answers`); UI changes
ship with a smoke test; and every milestone ends with the reference package(s) still validating
and running end-to-end via the CLI.
