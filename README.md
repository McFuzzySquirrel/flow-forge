# FlowForge

**An Agent Workforce Platform.** FlowForge separates the *platform* from the *knowledge and process*: the application knows nothing until a **Workforce Package** is installed. Install `Grade7-Maths.workforce` and a classroom workforce appears — Planner, Curriculum, Assessment, Feedback and Teacher agents, their skills, personas, workflows and rubrics. Install `Corporate-Onboarding.workforce` and the same software becomes a different workforce. Education is the flagship use case, not the limit.

## Core concepts

| Concept | What it is |
| --- | --- |
| **Workforce Package** | The unit of distribution (`.workforce`): agents, skills, personas, workflows, rubrics, knowledge, permissions, branding. Versioned, validatable, shareable. |
| **Agent** | A digital specialist with a role, skills, tools, model-tier requirement, its own memory namespace and enforced permissions. |
| **Skill** | A plug-in folder (`skill.json` + `skills.md` + prompts + tools) of domain knowledge. Swapping the curriculum swaps skills — no code changes. |
| **Persona** | Interaction style and decision policy layered *on top of* capability. The same Assessment Agent can be a Supportive Mentor or a Strict Examiner. |
| **Workflow** | A declarative spec (agent steps, human-input, human-approval, retry, branch). Human-in-the-loop is a first-class node type. Portable across runners. |
| **State vs Memory** | State is transactional workflow data (engine-owned). Memory is accumulated knowledge, owned per agent in its own namespace — replacing one agent never loses another's memory. |
| **Audit** | Every agent step and human override emits an immutable, hash-chained audit record: prompt version, model, evidence, rubric section, score, confidence, overrides. Every mark is explainable. |

## Repository layout

```
packages/
  core/                @flowforge/core      — domain types + the six JSON Schemas + validator
  workforce-packages/  @flowforge/packages  — .workforce package loader & cross-reference validation
  agents/              @flowforge/agents    — agent runtime + model provider abstraction (mock / Ollama / OpenAI-compatible)
  memory/              @flowforge/memory    — per-agent memory service (swappable vector store)
  audit/               @flowforge/audit     — append-only, hash-chained audit log
  workflow/            @flowforge/workflow  — embedded workflow engine (pause/resume, retries, branching)
  cli/                 @flowforge/cli       — flowforge validate | inspect | run
fixtures/
  Grade7-Maths.workforce/                   — reference workforce package
```

## Getting started

```bash
pnpm install
pnpm build
pnpm test

# validate & explore the reference package
node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce
node packages/cli/dist/index.js inspect fixtures/Grade7-Maths.workforce

# run the assignment workflow headlessly (mock model, interactive human steps)
node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock
```

## Design rules

1. **Schemas first** — nothing consumes a format without a validating schema (`packages/core/schemas/`).
2. **Everything behind an interface** — `ModelProvider`, `VectorStore`, `StateStore`, `AuditSink` are swappable (local/offline vs cloud).
3. **No hardcoded agents** — all behaviour comes from packages; the platform installs empty.
4. **Audit is runtime-enforced** — an agent step cannot run without emitting an audit record.

## Roadmap

The detailed, task-level plan for the next phases — including "learn while you build" notes on the
concepts behind each milestone — lives in [docs/PLAN.md](docs/PLAN.md).

- **Phase 0 — Foundations** ✅ monorepo, six core schemas, CLI validator, reference package
- **Phase 1 — Kernel** ✅ package loader, agent runtime, memory service, workflow engine, audit log, end-to-end headless test
- **Phase 2 — Vertical slice UI** — Electron + React shell, teacher & learner portals, audit viewer
- **Phase 3 — Differentiators** — persona picker, Coach & Reflection agents, long-term memory in anger, visual workflow editor
- **Phase 4 — Ecosystem** — package export/signing, second domain package, Dapr Workflows runner
