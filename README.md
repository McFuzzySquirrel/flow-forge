# FlowForge

**An Agent Workforce Platform.** FlowForge separates the *platform* from the
*knowledge and process*: the software knows nothing until you install a
**Workforce Package**. Install `Grade7-Maths.workforce` and a classroom appears —
Planner, Assessment, Feedback and Teacher agents running assignment workflows
with a teacher and student in the loop. Install `Corporate-Onboarding.workforce`
and the same software becomes an onboarding platform with HR, Buddy, Compliance
and Manager agents. Education is the flagship use case, not the limit.

Every agent step and human approval emits an immutable, hash-chained **audit
record**; humans are authenticated and role-checked; memory accumulates per
agent. Install, run, audit — nothing is hardcoded.

> FlowForge is an open engineering experiment exploring an Agent Learning
> Operating System: where workflows, people, AI agents, skills and knowledge
> evolve together through continuous learning.

---

## Quickstart (5 minutes, no API keys, no Docker)

Requirements: **Node 20+**. Everything below uses the built-in mock model, so
it works offline immediately.

```bash
git clone https://github.com/McFuzzySquirrel/flow-forge.git
cd flow-forge

corepack enable && corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm build
```

`pnpm install` links the CLI's `flowforge` command into
`node_modules/.bin/`, so it's available in the repo as **`pnpm exec flowforge`**
(right away, no extra steps).

Then run a full classroom workflow (teacher → student → teacher, all scripted):

```bash
pnpm exec flowforge run fixtures/Grade7-Maths.workforce assignment --mock \
  --answers answers.json
```

with `answers.json`:

```json
[
  { "value": "Solve one- and two-step linear equations, show your working." },
  { "value": "x + 3 = 10, so x = 7" },
  { "approved": true, "reason": "Correct method, well shown." }
]
```

The run completes, the audit trail prints, and it's persisted to `~/.flowforge`:

```bash
pnpm exec flowforge runs list
pnpm exec flowforge audit verify
```

**Prefer bare `flowforge`?** Optional one-time setup installs it system-wide so
you can drop the `pnpm exec`:

```bash
pnpm setup          # add pnpm's global bin dir to your shell PATH
pnpm link --global ./packages/cli
# then open a new terminal and use: flowforge ...
```

(Or `node packages/cli/dist/index.js …` always works.)

**Prefer a UI?** `pnpm --filter @flowforge/desktop dev` opens the desktop app
(home, portals, audit viewer, governance with model controls, and a visual
workflow editor with saveable workflow/skill edits).

---

## Getting started (for real use)

1. **Bootstrap & build** (as above).
2. **Configure** — `pnpm exec flowforge setup` interactively detects your
   environment and guides you through model provider (local Ollama or a cloud
   API), models, vector store and identity. It writes a secret-free
   `flowforge.config.json` (`~/.flowforge/config.json`) and puts API keys in a
   git-ignored `.env`. `pnpm exec flowforge doctor` prints a read-only health
   checklist anytime.
3. **Run** — commands read the config automatically; drop `--mock` to use your
   real provider. Precedence is flags > env > config.

The desktop app now reads the same secret-free config and uses the configured
provider mapping for workflow runs too, so Ollama/cloud model choices are
consistent between CLI and UI.

## Common commands

> In the table, `flowforge` means `pnpm exec flowforge` (from the repo) — or
> the system-wide `flowforge` after the optional global setup above.

| Task | Command |
|---|---|
| Validate a package | `flowforge validate <package-dir>` |
| Validate workflow graphs too | `flowforge validate <package-dir> --graph` |
| Inspect agents/skills/workflows | `flowforge inspect <package-dir>` |
| Run a workflow (interactive) | `flowforge run <dir> <workflow-id> --mock` |
| Run headlessly | `flowforge run <dir> <workflow-id> --mock --answers file.json` |
| Run with a persona | `flowforge run <dir> assignment --mock --persona supportive-mentor` |
| List / show runs | `flowforge runs list` · `flowforge runs show <id>` |
| Audit trail / verify / export | `flowforge audit show` · `audit verify` · `audit export` |
| Memory list / delete | `flowforge memory list <namespace>` · `memory delete <ns> <id>` |
| Package, sign, verify | `flowforge pack` · `verify` · `unpack` · `keygen` |
| Desktop app | `pnpm --filter @flowforge/desktop dev` |
| Test suite | `pnpm test` |

The full day-to-day walkthrough — quickstart, worked scenarios (classroom and
onboarding), disk layout, troubleshooting — lives in the
**[user guide](docs/user-guide.md)**.

---

## Core concepts

| Concept | What it is |
| --- | --- |
| **Workforce Package** | The unit of distribution (`.workforce`): agents, skills, personas, workflows, rubrics, knowledge, permissions, branding. Versioned, validatable, signable, shareable. |
| **Agent** | A digital specialist with a role, skills, tools, model-tier requirement, its own memory namespace and enforced permissions. |
| **Skill** | A plug-in folder of domain knowledge with a single `SKILL.md` ([Agent Skills](https://agentskills.io) format) plus prompts and tools. Swapping the curriculum swaps skills — no code changes. |
| **Persona** | Interaction style and decision policy layered *on top of* capability. The same Assessment Agent can be a Supportive Mentor or a Strict Examiner. |
| **Workflow** | A declarative spec (agent steps, human-input, human-approval, retry, branch). Human-in-the-loop is a first-class node type. Portable across runners. |
| **State vs Memory** | State is transactional workflow data (engine-owned). Memory is accumulated knowledge, owned per agent in its own namespace — replacing one agent never loses another's memory. |
| **Audit** | Every agent step and human override emits an immutable, hash-chained audit record: prompt version, model, evidence, score, confidence, overrides. Every mark is explainable. |

## Repository layout

```
packages/
  core/                @flowforge/core      — domain types + JSON Schemas + validator
  workforce-packages/  @flowforge/packages  — .workforce loader & cross-reference validation
  agents/              @flowforge/agents    — agent runtime + model providers (mock / Ollama / DeepSeek / OpenAI-compatible)
  memory/              @flowforge/memory    — per-agent memory service (swappable vector store)
  audit/               @flowforge/audit     — append-only, hash-chained audit log
  workflow/            @flowforge/workflow  — embedded engine + WorkflowRunner interface & conformance suite
  packaging/           @flowforge/packaging — deterministic .workforce archives, Ed25519 signing
  dapr-runner/         @flowforge/dapr-runner — Dapr Workflows implementation of WorkflowRunner
  identity/            @flowforge/identity  — OAuth/OIDC identity, claim-to-role mapping, sessions (ADR-0010)
  cli/                 @flowforge/cli       — flowforge validate | inspect | run | pack | verify | ...
  desktop/             @flowforge/desktop   — Electron + React desktop app (UI + visual workflow editor)
fixtures/
  Grade7-Maths.workforce/                   — reference package (education)
  Corporate-Onboarding.workforce/           — second-domain package (onboarding)
```

## Design rules

1. **Schemas first** — nothing consumes a format without a validating schema (`packages/core/schemas/`).
2. **Everything behind an interface** — `ModelProvider`, `VectorStore`, `StateStore`, `AuditSink` are swappable (local/offline vs cloud).
3. **No hardcoded agents** — all behaviour comes from packages; the platform installs empty.
4. **Audit is runtime-enforced** — an agent step cannot run without emitting an audit record.
5. **All human actions are authenticated and role-checked** — workflow input and approvals require a verified `Principal` from the configured OAuth/OIDC identity provider whose deployment-mapped roles match the node's declared role ([ADR-0010](docs/adr/0010-oidc-identity-and-role-based-authorization.md)).

The reasoning behind these and other foundational decisions is captured as
Architecture Decision Records in [docs/adr/](docs/adr/README.md).

---

## Documentation

- **[User guide](docs/user-guide.md)** — install, quickstart, desktop provider setup, workflow authoring, everyday tasks
- **[Testing guide](docs/testing.md)** — the test suite and wiring real LLM providers
- **[Package author guide](docs/authoring-packages.md)** — authoring your own `.workforce` packages
- **[Dapr runner](docs/dapr-runner.md)** — running workflows on a hosted Dapr stack
- **[Build plan](docs/PLAN.md)** — the task-level roadmap with "learn while you build" notes
- **[CHANGELOG](CHANGELOG.md)** — history of notable changes

## Status

- **Phase 0 — Foundations** ✅ monorepo, six core schemas, CLI validator, reference package
- **Phase 1 — Kernel** ✅ package loader, agent runtime, memory, workflow engine, audit log, end-to-end headless test
- **Phase 2 — Headless completeness & kernel API hardening** ✅ `KernelApi`, file-backed persistence, full CLI *(revised per ADR-0011)*
- **Phase 3 — Differentiators** ✅ personas, Coach/Reflection agents, memory write policy, graph validation, Chroma/File vector stores, namespace isolation
- **Phase 4 — Ecosystem** ✅ `.workforce` packaging & signing, second-domain package, Dapr Workflows runner
- **Phase 5 — UI layer(s)** ✅ desktop app (home, portals, audit with model/output visibility, governance model controls, visual editor with persistence), OAuth/OIDC login *(mobile not pursued)*
