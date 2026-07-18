# Pages Architecture & LLM Integration

This document describes the current UI page/screen architecture of the FlowForge desktop shell and
explains how large language models (LLMs) are used throughout the system.

---

## 1. Desktop shell architecture

The desktop package (`packages/desktop`) is an Electron application composed of three distinct
layers, each with a strict boundary enforced by Electron's security model.

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer process (untrusted)                                   │
│  packages/desktop/renderer/src/App.tsx                          │
│  React + Vite, no Node access, no direct kernel access          │
│                                                                 │
│  calls window.flowforge.* (contextBridge allow-list only)       │
└────────────────────────┬────────────────────────────────────────┘
                         │  contextBridge (preload.cts)
                         │  — only allow-listed methods cross this boundary
                         │  — no nodeIntegration, sandbox: true
┌────────────────────────▼────────────────────────────────────────┐
│  Main process (trusted)                                         │
│  packages/desktop/src/main.ts                                   │
│  Electron + Node.js, hosts the kernel, handles IPC              │
│                                                                 │
│  registerIpcHandlers() wires IpcChannels → DesktopKernel        │
└────────────────────────┬────────────────────────────────────────┘
                         │  direct function call
┌────────────────────────▼────────────────────────────────────────┐
│  FlowForgeKernel (packages/kernel)                              │
│  KernelApi reference implementation                             │
│  Owns all business logic: packages, runs, audit, identity       │
└─────────────────────────────────────────────────────────────────┘
```

### IPC contract

The typed IPC contract lives in `packages/desktop/src/ipc.ts`. It defines:

- **`IpcChannels`** — string constants for every channel (`flowforge:validate-package`, etc.).
- **`FlowForgeApi`** — the renderer-facing async interface that the `contextBridge` preload
  exposes as `window.flowforge`. Every method is a `Promise`-returning function that maps
  directly onto a `KernelApi` method.

Snapshot types (plain, JSON-serializable records) are defined in `@flowforge/kernel` and
re-exported from `ipc.ts` so that the renderer and main process share a single source of truth
with no class instances, no circular references, and no Node.js-specific objects.

### Kernel API surface

`packages/kernel/src/api.ts` defines the `KernelApi` interface — the single contract every
consumer (CLI, Electron, future mobile/web) depends on:

| Method | Description |
| --- | --- |
| `validatePackage(dir)` | Validate a `.workforce` package without loading it |
| `loadPackage(dir)` | Validate, load, and persist a package |
| `listPackages()` | List all loaded packages |
| `removePackage(id)` | Unload and remove a package from the registry |
| `startRun(packageId, workflowId)` | Start a new workflow run |
| `resumeRun(runId, response)` | Resume a paused run with a human response |
| `listRuns(packageId?)` | List persisted runs |
| `getRun(id)` | Get a single run by id |
| `getAuditTrail(filter?)` | Fetch audit records with optional filters |
| `signIn(role)` | Sign in via dev identity (OIDC deferred to Phase 5) |
| `signOut()` | Sign out the current user |
| `getCurrentUser()` | Return the signed-in user snapshot |

---

## 2. Current pages (Milestone 2.1 shell)

The current desktop UI is a **single React component** (`App.tsx`) that acts as a vertical-slice
proof of the IPC bridge. It is intentionally minimal — no routing, no dedicated page components —
and is parked at this state until Phase 5 (see ADR-0011 and `docs/PLAN.md`).

The component is divided into four sections that map directly onto the KernelApi surface:

### Section 1 — Workforce Package

**Purpose:** load and inspect a `.workforce` package from the local filesystem.

**Interactions:**
- User types a directory path and clicks **Validate & load**.
- Calls `window.flowforge.validatePackage(dir)` then `window.flowforge.loadPackage(dir)`.
- On success: displays the package name, version, description, agent roster (name, role, model
  tier, skills), and a list of workflows with **Start run** buttons.
- On failure: schema validation errors are surfaced inline.

**Data rendered:** `PackageSummary` → `AgentSummary[]`, `WorkflowSummary[]`. Nothing on screen is
hardcoded; swapping the package changes every label (design rule 3).

### Section 2 — Identity

**Purpose:** authenticate as one of the package's workflow roles.

**Interactions:**
- Before a package is loaded: no role buttons are shown.
- After a package is loaded: one **Sign in as `<role>`** button per unique role extracted from
  workflow nodes (via `WorkflowSummary.roles`).
- Calls `window.flowforge.signIn(role)`, which uses the dev identity provider (one mock user per
  role). OIDC authorization-code + PKCE is deferred to Phase 5.
- Shows the signed-in user's display name, roles, and provider; **Sign out** calls
  `window.flowforge.signOut()`.

**Data rendered:** `UserSnapshot` — never contains tokens or raw claims.

### Section 3 — Run

**Purpose:** start and advance a workflow run, including human-input and human-approval steps.

**Interactions:**
- **Start run:** clicking a workflow's **Start run** button calls
  `window.flowforge.startRun(packageId, workflowId)`. The run may immediately be
  `waitingForHuman` if the first node is a human step.
- **Human-input node:** shows the node's prompt, a text area, and a **Submit** button that calls
  `window.flowforge.resumeRun(runId, { value: answer })`.
- **Human-approval node:** shows the pending subject (formatted JSON), a reason field, and
  **Approve** / **Reject** buttons that call `resumeRun` with `{ approved: true/false, reason }`.
- After each resume the run snapshot and audit trail are refreshed.
- Authorization errors (wrong role, wrong participant) surface as `run.error`.

**Data rendered:** `RunSnapshot` — `status`, `currentNodeId`, `pending` (with `kind`, `role`,
`prompt`, `subject`).

### Section 4 — Audit trail

**Purpose:** show the immutable audit log for the current run.

**Interactions:**
- Refreshed automatically after every start/resume.
- Displays each record's timestamp, actor (`type:id`), action, and node (if any).
- Shows whether the hash chain is intact.

**Data rendered:** `AuditTrailSnapshot` — `records[]`, `chainIntact`.

---

## 3. Planned pages (Phase 5)

Phase 5 replaces the single-component shell with a full set of dedicated pages. All of them are
thin rendering surfaces over the frozen `KernelApi` — no business logic lives in the renderer.
Every user action must be reproducible via the CLI (the Phase 5 exit criterion).

| Page | Role | Key KernelApi calls |
| --- | --- | --- |
| **Package installation** | All | `validatePackage`, `loadPackage` |
| **Workforce home** | All | `listPackages` |
| **Teacher portal — start & monitor** | Teacher | `startRun`, `getRun`, `resumeRun` |
| **Teacher portal — human approval** | Teacher | `resumeRun` (with `approved`) |
| **Learner portal — task inbox** | Learner | `listRuns`, `getRun`, `resumeRun` |
| **Learner portal — feedback view** | Learner | `getRun`, `getAuditTrail` |
| **Audit viewer** | Admin/Teacher | `getAuditTrail` (with filters) |
| **Admin governance** | Admin | `signIn`, `getAuditTrail` |
| **Visual workflow editor** | Package author | `validatePackage` |

See `docs/PLAN.md` (Milestone 5.1) for the full task breakdown and "done when" criteria.

---

## 4. How LLMs are used

LLMs (large language models) are the execution engine for every **agent step** in FlowForge.
They are invoked exclusively by the `AgentRuntime` inside `packages/agents`, always behind the
`ModelProvider` interface, and every call is recorded in the immutable audit log.

### 4.1 The `ModelProvider` interface

```
packages/agents/src/providers.ts
```

All LLM communication goes through a single, small interface:

```typescript
interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
```

`CompletionRequest` carries an OpenAI-style `messages` array (`system`, `user`, `assistant`
roles), an optional model name, and an optional temperature. `CompletionResponse` returns
`content` (the raw model output) and the `model` name that actually ran.

**Concrete implementations shipped today:**

| Class | When to use |
| --- | --- |
| `MockModelProvider` | Tests and offline development — deterministic, no network |
| `OllamaProvider` | Local models (default: `llama3.2`) via the Ollama HTTP API |
| `OpenAICompatibleProvider` | Any OpenAI-compatible REST endpoint (OpenAI, Azure OpenAI, Together AI, etc.) |

New providers (e.g. a Anthropic adapter, a Gemini adapter) are additive — they implement the
interface and are registered in the `ModelRegistry` at composition time.

### 4.2 Model tiers

Agents do not name a concrete model. Instead they declare a **tier** (`small`, `medium`, or
`large`) and, optionally, a `preferredModel` hint within that tier:

```json
"model": { "tier": "large", "preferredModel": "gpt-4o", "temperature": 0.2 }
```

At deployment time a `ModelRegistry` maps each tier to a `ModelProvider` instance. This means:

- The same workforce package runs offline (all tiers → Ollama) or in the cloud (large → GPT-4o,
  small → llama3.2) without any package changes.
- An operator can gradually upgrade model quality by re-mapping a tier without touching workflows.
- Tests always use `MockModelProvider` for all tiers, keeping the test suite deterministic and
  network-free.

### 4.3 Prompt assembly

Each call to `AgentRuntime.step()` builds a two-message prompt:

**System message** (assembled by `buildSystemPrompt`):

1. The agent's `systemPrompt` (or a default derived from `agent.name` and `agent.role`).
2. One block per skill the agent carries — `Skill (<displayName>): <description>\n\n<instructions>`.
   The `instructions` are the Markdown body of the skill's `SKILL.md` file (ADR-0009).
3. If a persona is active: `Persona (<name>): <promptOverlay>`.

**User message:**

1. `Task: <action>` — the workflow node's declared action string.
2. One block per named workflow-state input (`<key>:\n<value>`).
3. If memory recall returned results: `Relevant memory:\n- <text>` for each recalled item.

The SHA-256 hash of the assembled system prompt is recorded as `promptVersion` in the audit
record. This means any change to an agent's skills, persona or instructions produces a new
`promptVersion`, making prompt evolution traceable.

### 4.4 Memory recall and RAG

Before the LLM call, the runtime queries the agent's memory namespace for context relevant to the
current task:

```
recalled = memory.recall(namespace, `${action} ${JSON.stringify(inputs)}`)
```

Retrieved items are appended to the user message and included as `evidence` entries in the audit
record. This is **retrieval-augmented generation (RAG)**: the model's context is enriched with
accumulated knowledge before it generates a response.

The current `MemoryService` uses a lexical (token-overlap) similarity score — sufficient for
tests. Phase 3 (Milestone 3.3) replaces this with a real `VectorStore` adapter (e.g. Chroma)
backed by embedding models, without changing the interface or any prompt logic.

### 4.5 Output parsing

Model responses are expected to be JSON objects (the agent's system prompt instructs this). The
runtime tries to parse the raw completion as JSON — stripping any markdown code-fence wrapper —
and falls back to treating the response as a plain string if parsing fails.

Well-known fields on the parsed object (`score`, `confidence`, `rubricSection`) are extracted and
forwarded to the audit record. Any additional fields are passed as-is to the workflow's state bag
for downstream nodes to consume.

### 4.6 Audit of every model call

Every `AgentRuntime.step()` call emits exactly one audit record before returning. There is no code
path through the runtime that skips this (design rule 4 — audit is runtime-enforced). The record
contains:

| Field | What it captures |
| --- | --- |
| `actor` | `{ type: "agent", id: agentId, persona: personaId? }` |
| `action` | `"agent.step"` |
| `promptVersion` | SHA-256 (first 12 hex chars) of the assembled system prompt |
| `model` | `{ provider: providerName, name: completionModel }` |
| `evidence` | Memory items recalled, each with source path, excerpt, and relevance score |
| `score`, `confidence`, `rubricSection` | Extracted from the model's JSON output where present |
| `workflowRunId`, `nodeId` | Links the record to the exact workflow node that triggered it |

This audit trail means any mark, recommendation or output can be explained after the fact: which
agent ran, which persona applied, which prompt version, which model, what evidence was retrieved,
and what score was produced.

### 4.7 LLM placement in the request flow

```
CLI / Electron UI
      │
      │  KernelApi.startRun / resumeRun
      ▼
FlowForgeKernel  ──►  WorkflowEngine
                              │
                              │  agent node encountered
                              ▼
                       AgentRuntime.step()
                              │
                    ┌─────────┼──────────┐
                    │         │          │
                    ▼         ▼          ▼
              MemoryService  ModelRegistry  AuditLog
              .recall()      .get(tier)    .record()
                              │
                              ▼
                        ModelProvider.complete()
                        (Mock / Ollama / OpenAI-compatible)
```

Human nodes (`humanInput`, `humanApproval`) do **not** call the LLM — they pause the run and wait
for a `Principal`-authenticated `resumeRun` call. LLMs are only invoked for agent nodes.
