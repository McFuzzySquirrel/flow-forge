# FlowForge Build Plan — Phases 2–4

This is the detailed working plan for the next phases of FlowForge. It breaks each phase into
milestones and tasks, and every milestone includes a **📚 Learn while you build** section that
explains the concepts, patterns and trade-offs involved — so the plan doubles as a learning
companion.

**Where we are:** Phase 0 (Foundations) and Phase 1 (Kernel) are complete. The monorepo builds
(`pnpm build`), tests pass (`pnpm test`), and the CLI can validate, inspect and headlessly run the
`Grade7-Maths.workforce` reference package with the mock model provider.

**Design rules that govern everything below** (see README):

1. Schemas first — nothing consumes a format without a validating schema.
2. Everything behind an interface — `ModelProvider`, `VectorStore`, `StateStore`, `AuditSink` are swappable.
3. No hardcoded agents — all behaviour comes from `.workforce` packages.
4. Audit is runtime-enforced — every agent step emits an immutable, hash-chained audit record.

---

## Phase 2 — Vertical Slice UI

**Goal:** a desktop app (Electron + React) where a teacher can install a workforce package, launch
the assignment workflow, a learner can submit work, and both can watch the agents work and inspect
the audit trail. "Vertical slice" means one complete end-to-end journey through the UI — not a
broad-but-shallow UI over everything.

### Milestone 2.1 — Application shell & IPC bridge

| # | Task | Done when |
| --- | --- | --- |
| 2.1.1 | Scaffold `packages/desktop` (Electron main process + Vite/React renderer) in the pnpm workspace | `pnpm --filter @flowforge/desktop dev` opens an empty window |
| 2.1.2 | Define a typed IPC contract (`packages/desktop/src/ipc.ts`) — request/response types shared between main and renderer | Renderer calls are fully typed; no `any` crosses the bridge |
| 2.1.3 | Wire the kernel into the main process: expose `validatePackage`, `loadPackage`, `startRun`, `resumeRun`, `getRun`, `getAuditTrail` over IPC | Renderer can list a loaded package's agents/workflows |
| 2.1.4 | Add a `contextBridge` preload with a minimal, allow-listed API surface (no `nodeIntegration`) | Security checklist passes: renderer has no direct Node access |
| 2.1.5 | Add desktop package to root `pnpm build` / `pnpm lint` / CI | Fresh clone builds everything with one command |

**📚 Learn while you build — Electron process model & IPC security**

- Electron runs **two kinds of processes**: the *main* process (Node.js — filesystem, kernel
  packages, windows) and *renderer* processes (Chromium — your React app). They cannot share
  memory; they talk over **IPC** (inter-process communication), which is message passing —
  conceptually the same as a client calling an HTTP API.
- The golden security rule: renderers should be treated as untrusted web content. That's why we
  disable `nodeIntegration` and use a **preload script + `contextBridge`** to expose only a small,
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
| 2.3.3 | Human-input node UI: render the node's `prompt`, collect the teacher's answer, resume the run | The `create-assignment` step of the assignment workflow works end-to-end |
| 2.3.4 | Human-approval node UI: show the `subject` (e.g. proposed marks), approve / reject with reason | Rejection reason lands in workflow state and the audit trail |
| 2.3.5 | Retry/failure surfacing: show attempt counts and terminal failures with the error | A failing mock provider produces a readable failure card |

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
| 2.4.1 | Role selection / simple profile switch (teacher vs learner) — local only, no auth service yet | Portals show only the human tasks for their role |
| 2.4.2 | Learner task inbox: pending `humanInput` nodes where `role == "learner"` (e.g. "submit your work") | Submitting resumes the run |
| 2.4.3 | Feedback view: rendered feedback + score once the workflow completes, with "why?" linking to audit records | Learner can see evidence and rubric section behind their mark |

**📚 Learn while you build — roles and authorisation**

- Filtering tasks by the node's `role` field is **role-based access control (RBAC)** in miniature.
  We deliberately start with local role switching to keep the slice thin; real identity comes
  later. The lesson: separate *authentication* (who are you) from *authorisation* (what may you
  do) — the workflow schema already encodes the authorisation side.
- The "why?" link is **explainability by construction**: because audit is runtime-enforced (design
  rule 4), the UI never has to reconstruct an explanation — it just renders records that already exist.

### Milestone 2.5 — Audit viewer

| # | Task | Done when |
| --- | --- | --- |
| 2.5.1 | Audit trail screen per run: chronological records with agent, action, prompt version, model, evidence, score, confidence | Every agent step in a run is visible |
| 2.5.2 | Hash-chain verification button: recompute the chain and show valid/tampered | Editing a record on disk makes verification fail visibly |
| 2.5.3 | Filter by agent / node / human overrides; export a run's trail to JSON | Exported file re-verifies with the CLI |

**📚 Learn while you build — tamper-evident logs**

- The audit log is a **hash chain**: each record includes the hash of the previous record, so
  changing any historical record breaks every hash after it. This is the core mechanism behind
  git commits and blockchains — no distributed consensus needed, just linked hashes.
- Distinguish **tamper-evident** (you can *detect* changes — what we have) from **tamper-proof**
  (you can *prevent* them — needs write-once storage or external anchoring). Phase 4's signing
  work builds on this distinction.

### Phase 2 exit criteria

- One command starts the desktop app; installing `fixtures/Grade7-Maths.workforce` and running the
  assignment workflow end-to-end works with the mock provider and with Ollama.
- Zero domain knowledge in the UI code — verified by rendering a second (even trivial) package.
- Existing kernel tests still pass; new UI-level smoke test (Playwright or Vitest + Electron) covers
  the vertical slice.

---

## Phase 3 — Differentiators

**Goal:** the features that make FlowForge more than a workflow runner — personas that change
behaviour, agents that coach and reflect, memory that genuinely accumulates, and a visual editor
for workflows.

### Milestone 3.1 — Persona picker & persona enforcement

| # | Task | Done when |
| --- | --- | --- |
| 3.1.1 | Extend the agent runtime to compose system prompts as *capability (skill) + persona overlay*, with the persona layer clearly delimited | Prompt assembly is unit-tested; audit records capture persona id + version |
| 3.1.2 | Persona picker UI on the agent detail screen (choose among the package's personas allowed for that agent) | Same Assessment agent runs as "Supportive Mentor" vs "Strict Examiner" with visibly different feedback |
| 3.1.3 | Persona decision-policy hooks: thresholds/settings a persona can adjust (e.g. strictness affects approval routing), schema-validated | Policy values come from `persona.schema.json`-validated data, not code |
| 3.1.4 | A/B run comparison view: run the same submission under two personas, diff the feedback side by side | Comparison view renders from two runs' audit trails |

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
| 3.2.2 | New `revision` workflow: after feedback, Coach proposes practice steps; learner works through them; Reflection agent summarises what the learner should internalise | Workflow runs headlessly and in the UI |
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

### Milestone 3.4 — Visual workflow editor

| # | Task | Done when |
| --- | --- | --- |
| 3.4.1 | Read-only workflow diagram (React Flow or similar): render any `workflow.schema.json` document as a node graph | The assignment workflow renders correctly, branches included |
| 3.4.2 | Live run overlay: highlight current node, completed path, pending human task on the diagram | Watching a run animates the graph |
| 3.4.3 | Editing: add/remove/connect nodes; node property panels per node type (agent, humanInput, humanApproval, branch) | Edits round-trip: load → edit → save produces valid JSON |
| 3.4.4 | Continuous validation in the editor: schema errors + graph-level checks (unreachable nodes, missing `start`, dangling `next`, branch without default) | Invalid graphs cannot be saved silently |
| 3.4.5 | "Dry run" button: execute the edited workflow with the mock provider from inside the editor | Author → test loop without leaving the editor |

**📚 Learn while you build — DSLs, graphs and projectional editing**

- The workflow JSON is a **declarative DSL** (domain-specific language): it says *what* happens,
  not *how*. The visual editor is a **projection** of that DSL — the JSON stays the single source
  of truth, and the diagram is just another view. Resisting a separate "editor format" avoids the
  classic two-sources-of-truth drift problem.
- Workflows are **directed graphs**, so editor validation is graph algorithms: reachability from
  `start` (BFS/DFS), detecting dangling edges, and (if you disallow them) cycle detection. This is
  where CS fundamentals show up in product code.
- Layering validation — JSON Schema (shape) then graph checks (semantics) — mirrors how compilers
  work: syntax first, then semantic analysis.

### Phase 3 exit criteria

- Persona switch demonstrably changes agent behaviour, with the persona recorded in audit.
- Coach/Reflection revision workflow runs end-to-end; memory measurably influences coaching.
- Chroma-backed memory passes the shared `VectorStore` test suite.
- A workflow authored entirely in the visual editor validates and runs.

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
| 4.2.3 | Run both packages side by side in the desktop app | Two workforce homes, isolated memory, isolated audit |
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

---

## Cross-phase — Identity & Governance (ADR-0010)

**Goal:** authenticated, role-checked human actions across every surface, with any OIDC-compliant
identity provider (Microsoft Entra ID, Google Workspace for Education, Auth0, Keycloak).

Shipped in the kernel (this phase-0/1 slice):

| # | Task | Done when |
| --- | --- | --- |
| I.1 | ADR-0010 settles the identity architecture (OIDC-only; dedicated session store; RBAC + per-run participant binding; packages declare roles, deployments map claims) | ADR accepted and indexed ✔ |
| I.2 | `identity.schema.json` in `packages/core/schemas` — providers, claim-to-role mappings, role permissions, session policy | Config validates via `validate('identity', …)` with tests ✔ |
| I.3 | `packages/identity` — `IdentityProvider` interface, `OidcIdentityProvider` (auth-code + PKCE, device flow, refresh, userinfo), `MockIdentityProvider`, `IdentityRegistry`, `RoleMapper`, `PermissionPolicy`, `SessionStore`, `IdentityService` with audited auth events | Unit tests cover claim mapping, sessions, audited login/refresh/denial ✔ |
| I.4 | Engine enforcement — `WorkflowEngine.resume` requires a `Principal`, checks the node role, binds roles per run, audits `workflow.authorization.denied` | Grade7-Maths tests prove a student cannot approve and a teacher cannot submit student work ✔ |
| I.5 | CLI wiring — dev identity by default; `--identity <config.json>` signs users in via the OIDC device flow | `flowforge run … --identity` completes a device-flow login ✔ |

Follow-up work (slot into the phases below):

| # | Task | Done when |
| --- | --- | --- |
| I.6 | Desktop app login via authorization-code + PKCE (Milestone 2.1+) | UI shows the signed-in user; every human step passes the Principal |
| I.7 | Persistent `SessionStore` implementation (with 4.3's persistence substrate) | Sessions survive restart; revocation works across nodes |
| I.8 | Admin governance UI — role-mapping management, session policy, per-user audit trail (builds on `IdentityService.auditTrailForUser`) (Milestone 2.5+) | Admin can review who did what, as which role, asserted by which provider |

---

## Suggested build order & dependencies

```
Phase 2:  2.1 → 2.2 → 2.3 → 2.4 → 2.5        (strictly sequential; each screen builds on the last)
Phase 3:  3.1 and 3.3 can start in parallel; 3.2 depends on 3.3.1 (real recall);
          3.4 is independent of 3.1–3.3
Phase 4:  4.1 and 4.2 can start in parallel; 4.3 last (benefits from a hardened schema after 4.2)
```

Working agreement for every task: schema changes land first with validator tests; kernel changes
ship with unit tests; UI changes ship with a smoke test on the vertical slice; and every milestone
ends with the reference package(s) still validating and running end-to-end.
