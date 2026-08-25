# FlowForge

**An Agent Workforce Platform.** FlowForge separates the *platform* from the *knowledge and process*: the application knows nothing until a **Workforce Package** is installed. Install `Grade7-Maths.workforce` and a classroom workforce appears — Planner, Curriculum, Assessment, Feedback and Teacher agents, their skills, personas, workflows and rubrics. Install `Corporate-Onboarding.workforce` and the same software becomes a different workforce. Education is the flagship use case, not the limit.

> "FlowForge is an open engineering experiment exploring what an Agent Learning Operating System could look like: where workflows, people, AI agents, skills and knowledge evolve together through continuous learning."

## Core concepts

| Concept | What it is |
| --- | --- |
| **Workforce Package** | The unit of distribution (`.workforce`): agents, skills, personas, workflows, rubrics, knowledge, permissions, branding. Versioned, validatable, shareable. |
| **Agent** | A digital specialist with a role, skills, tools, model-tier requirement, its own memory namespace and enforced permissions. |
| **Skill** | A plug-in folder of domain knowledge with a single `SKILL.md` ([Agent Skills](https://agentskills.io) format: YAML frontmatter manifest + Markdown instructions) plus prompts and tools. Swapping the curriculum swaps skills — no code changes. |
| **Persona** | Interaction style and decision policy layered *on top of* capability. The same Assessment Agent can be a Supportive Mentor or a Strict Examiner. |
| **Workflow** | A declarative spec (agent steps, human-input, human-approval, retry, branch). Human-in-the-loop is a first-class node type. Portable across runners. |
| **State vs Memory** | State is transactional workflow data (engine-owned). Memory is accumulated knowledge, owned per agent in its own namespace — replacing one agent never loses another's memory. |
| **Audit** | Every agent step and human override emits an immutable, hash-chained audit record: prompt version, model, evidence, rubric section, score, confidence, overrides. Every mark is explainable. |

## Repository layout

```
packages/
  core/                @flowforge/core      — domain types + the six JSON Schemas + validator
  workforce-packages/  @flowforge/packages  — .workforce package loader & cross-reference validation
  agents/              @flowforge/agents    — agent runtime + model provider abstraction (mock / Ollama / DeepSeek / OpenAI-compatible)
  memory/              @flowforge/memory    — per-agent memory service (swappable vector store)
  audit/               @flowforge/audit     — append-only, hash-chained audit log
  workflow/            @flowforge/workflow  — embedded workflow engine (pause/resume, retries, branching) + WorkflowRunner interface & conformance suite
  packaging/           @flowforge/packaging — deterministic .workforce archives, hash manifests, Ed25519 signing
  dapr-runner/         @flowforge/dapr-runner — Dapr Workflows implementation of WorkflowRunner
  identity/            @flowforge/identity  — OIDC identity, claim-to-role mapping, sessions (ADR-0010)
  cli/                 @flowforge/cli       — flowforge validate | inspect | run | pack | verify | ...
  desktop/             @flowforge/desktop   — Electron + React desktop shell (Phase 5 UI + visual workflow editor)
fixtures/
  Grade7-Maths.workforce/                   — reference workforce package (education)
  Corporate-Onboarding.workforce/           — second-domain workforce package (onboarding)
```

## Getting started

```bash
# 1. bootstrap (needs Node 20+; installs pnpm 11.5.2, deps, and compiles all packages)
corepack enable && corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm build

# 2. interactive setup — detects your environment and guides you through
#    provider, models, vector store and identity choices (also: `flowforge doctor`)
node packages/cli/dist/index.js setup

# 3. run the test suite (all mock-model, offline)
pnpm test
```

The interactive `setup` prompts you for a model provider (local Ollama or a cloud API),
offers to pull recommended Ollama models, chooses a vector store (file-backed by default,
Chroma if you prefer), and identity mode. It writes a `flowforge.config.json` (default
`~/.flowforge/config.json`) and, for cloud providers, your API key to a git-ignored `.env`.
Run `flowforge setup --non-interactive` to script it from flags.

Once configured, all commands below pick up the provider, models and data directory from
config automatically — pass `--provider`/`--api-key`/`--data-dir` to override per-run.

```bash
# validate & explore the reference package (and the second-domain package)
node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce
node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce --graph
node packages/cli/dist/index.js inspect fixtures/Grade7-Maths.workforce
node packages/cli/dist/index.js validate fixtures/Corporate-Onboarding.workforce

# run the assignment workflow headlessly (mock model, interactive human steps)
node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock

# run with a persona override
node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock --persona supportive-mentor

# run the Coach/Reflection revision workflow non-interactively
node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce revision --mock --answers answers.json

# run the corporate onboarding workflow non-interactively
node packages/cli/dist/index.js run fixtures/Corporate-Onboarding.workforce onboarding --mock --answers answers.json

# inspect persisted runs and audit trail
node packages/cli/dist/index.js runs list
node packages/cli/dist/index.js audit show
node packages/cli/dist/index.js audit verify

# browse and manage agent memory (file-backed, persisted in --data-dir)
node packages/cli/dist/index.js memory list dev.flowforge.grade7-maths/coach --data-dir ~/.flowforge
node packages/cli/dist/index.js memory delete dev.flowforge.grade7-maths/coach <item-id> --data-dir ~/.flowforge

# ecosystem: pack a package into a deterministic archive, sign it, verify it
node packages/cli/dist/index.js keygen ~/flowforge-signing.pem
node packages/cli/dist/index.js pack fixtures/Grade7-Maths.workforce --signing-key ~/flowforge-signing.pem --publisher "You"
node packages/cli/dist/index.js verify dev.flowforge.grade7-maths-1.0.0.workforce
node packages/cli/dist/index.js unpack dev.flowforge.grade7-maths-1.0.0.workforce --output ~/unpacked

# launch the desktop app (Phase 5 UI: home, portals, audit, governance, visual editor)
pnpm --filter @flowforge/desktop dev

# Dapr runner: conformance suite + hosted stack
pnpm vitest run packages/workflow packages/dapr-runner
docker compose -f docker/docker-compose.yml up --build
```

## Design rules

1. **Schemas first** — nothing consumes a format without a validating schema (`packages/core/schemas/`).
2. **Everything behind an interface** — `ModelProvider`, `VectorStore`, `StateStore`, `AuditSink` are swappable (local/offline vs cloud).
3. **No hardcoded agents** — all behaviour comes from packages; the platform installs empty.
4. **Audit is runtime-enforced** — an agent step cannot run without emitting an audit record.
5. **All human actions are authenticated and role-checked** — workflow input and approvals require an OIDC-verified `Principal` whose deployment-mapped roles match the node's declared role ([ADR-0010](docs/adr/0010-oidc-identity-and-role-based-authorization.md)).

The reasoning behind these and other foundational decisions is captured as Architecture Decision
Records in [docs/adr/](docs/adr/README.md).

A comprehensive guide to running tests and wiring up real LLM providers (Ollama, DeepSeek, OpenAI-compatible,
or custom) lives in [docs/testing.md](docs/testing.md).

A history of all notable changes lives in [CHANGELOG.md](CHANGELOG.md).

## Roadmap

The detailed, task-level plan for the next phases — including "learn while you build" notes on the
concepts behind each milestone — lives in [docs/PLAN.md](docs/PLAN.md).

Per-phase architecture docs:

- [Phase 1 kernel architecture](docs/phase-1-kernel-architecture.md)
- [Phase 2 headless kernel API architecture](docs/phase-2-headless-kernel-api-architecture.md)
- [Phase 3 differentiators architecture](docs/phase-3-differentiators-architecture.md)
- [Phase 4 ecosystem architecture](docs/phase-4-ecosystem-architecture.md)
- [Phase 5 UI architecture](docs/phase-5-ui-architecture.md)

For the desktop shell page breakdown, IPC layering, planned Phase 5 screens, and a full explanation
of how LLMs are integrated — see [docs/pages-architecture.md](docs/pages-architecture.md).

- **Phase 0 — Foundations** ✅ monorepo, six core schemas, CLI validator, reference package
- **Phase 1 — Kernel** ✅ package loader, agent runtime, memory service, workflow engine, audit log, end-to-end headless test
- **Phase 2 — Headless completeness & kernel API hardening** ✅ `KernelApi`, file-backed persistence, full CLI (`runs`, `audit`, `memory`), second consumer proof *(revised per ADR-0011)*
- **Phase 3 — Differentiators** ✅ persona enforcement, Coach & Reflection agents, memory write policy, graph validation, `EmbeddingProvider` abstraction, `ChromaVectorStore`, `FileVectorStore`, namespace isolation, retention/decay knobs
- **Phase 4 — Ecosystem** — package export/signing, second domain package, Dapr Workflows runner
- **Phase 5 — UI layer(s)** — Electron shell (completing original Phase 2 screens), visual workflow editor, optional mobile
