# Authoring `.workforce` packages

A package author guide for the FlowForge Agent Workforce Platform, distilled from the two reference
packages — `fixtures/Grade7-Maths.workforce` (education) and `fixtures/Corporate-Onboarding.workforce`
(corporate onboarding) — and from the JSON Schemas in `packages/core/schemas/`. Corporate-Onboarding
is the worked example throughout: it proves the format is domain-agnostic, since the same platform
that runs a classroom also runs a new-hire onboarding.

The five design rules from `docs/PLAN.md` govern everything here: **schemas first**; **everything
behind an interface**; **no hardcoded agents** (all behaviour comes from packages, the platform
installs empty); **audit is runtime-enforced** (every agent step emits an immutable, hash-chained
record); and **human actions are authenticated and role-checked** (every human step resumes with a
`Principal` whose roles are checked by the engine, not the UI). A package is *self-contained*: it
declares everything it needs and never depends on platform code written for its domain.

---

## 1. Package anatomy

A package is **the unit of distribution** — a directory with a `workforce.json` manifest at the root
plus one directory per artefact type, all referenced from the manifest by relative path.

```
Corporate-Onboarding.workforce/
├── workforce.json          # manifest (required, at the root)
├── agents/                 # one folder per agent: agent.json + prompt.md (+ optional files)
│   ├── hr-planner/  ├── buddy/  ├── compliance/  └── manager-review/
├── skills/onboarding/SKILL.md      # Agent Skills folders (+ optional prompts/tools)
├── personas/supportive-buddy.json  # persona.json files
├── workflows/onboarding.json       # workflow.json files
├── knowledge/onboarding-handbook.md# docs embedded into agent memories on install
└── rubrics/algebra-rubric.md       # optional domain documents (Grade7-Maths uses this)
```

All directories are optional *except* `agents/` and `workflows/`, which must each contain at least
one entry (the manifest requires `minItems: 1`).

---

## 2. The `workforce.json` manifest

Every field, from `packages/core/schemas/workforce-package.schema.json`, validated with
`additionalProperties: false` so unknown keys are rejected:

| Field | Required | Type / rule |
| --- | --- | --- |
| `specVersion` | yes | `"1.0"` (enum) — spec version this manifest conforms to |
| `id` | yes | Globally unique **reverse-DNS** id, `^[a-z0-9]+([.-][a-z0-9]+)*$` |
| `name` | yes | Human name, `minLength: 1` |
| `version` | yes | **Semver** of the package content, `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` |
| `description` | no | Free text |
| `domain` | no | e.g. `"education"`, `"onboarding"` |
| `engineVersion` | no | Semver **range** the engine must satisfy (e.g. `">=0.1.0"`); checked at install and by `verify` |
| `authors` | no | Array of strings |
| `license` | no | String |
| `agents` | yes | Relative paths to `agent.json`, `minItems: 1` |
| `skills` | no | Relative paths to `SKILL.md` files |
| `personas` | no | Relative paths to `persona.json` files |
| `workflows` | yes | Relative paths to `workflow.json`, `minItems: 1` |
| `rubrics` | no | Relative paths to rubric documents |
| `knowledge` | no | Array of `{ "path", "agents" }` — a source + the agent ids whose memories receive it |
| `permissions` | no | `{ "network": bool, "fileSystem": bool }`, both default `false` |
| `branding` | no | `{ "displayName", "icon", "primaryColor" }` for UI display |
| `signing` | no | Placeholder for provenance (Phase 4): `{ "algorithm", "signature", "publisher" }` |

The onboarding manifest (verbatim from `fixtures/Corporate-Onboarding.workforce/workforce.json`):

```json
{
  "specVersion": "1.0",
  "id": "com.example.corporate-onboarding",
  "name": "Corporate Onboarding",
  "version": "1.0.0",
  "description": "Second-domain reference package: a corporate onboarding workforce with HR-Planner, Buddy, Compliance and Manager-Review agents. Proves the package format is domain-agnostic.",
  "domain": "onboarding",
  "engineVersion": ">=0.1.0",
  "authors": ["FlowForge"],
  "license": "MIT",
  "agents": ["agents/hr-planner/agent.json", "agents/buddy/agent.json", "agents/compliance/agent.json", "agents/manager-review/agent.json"],
  "skills": ["skills/onboarding/SKILL.md"],
  "personas": ["personas/supportive-buddy.json"],
  "workflows": ["workflows/onboarding.json"],
  "knowledge": [{ "path": "knowledge/onboarding-handbook.md", "agents": ["buddy", "compliance"] }],
  "permissions": { "network": false, "fileSystem": false },
  "branding": { "displayName": "Corporate Onboarding", "primaryColor": "#0f766e" }
}
```

Note the `knowledge` entry: the handbook is embedded into the **buddy** and **compliance** agents'
memories on install; `rubrics` and `signing` are absent because both are optional. On
`engineVersion`: the engine publishes its own version (`ENGINE_VERSION`), and a package whose declared
range is unmet is **refused at install** — an old engine rejects a too-new package gracefully instead
of failing at runtime. ID patterns: package `id` is reverse-DNS (`com.example.corporate-onboarding`),
while agent / persona / workflow / skill ids use `^[a-z0-9]+(-[a-z0-9]+)*$` — lowercase letters,
digits, hyphens — e.g. `hr-planner`, `compliance-approval`, `supportive-buddy`.

---

## 3. Agents

An `agent.json` defines a **digital specialist**: role, skills, model requirements, memory namespace
and permissions. *Capability* lives here; *interaction style* lives in personas (section 5). Schema:
`packages/core/schemas/agent.schema.json` (`additionalProperties: false`).

| Field | Required | Type / rule |
| --- | --- | --- |
| `id` | yes | Package-unique, `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `name` | yes | Human name |
| `role` | yes | **One-sentence job description** |
| `systemPrompt` | no | Relative path to the base system prompt file (e.g. `"prompt.md"`) |
| `skills` | no | Skill ids (from the package) this agent is equipped with |
| `tools` | no | Tool ids this agent may invoke |
| `defaultPersona` | no | Persona id applied unless overridden |
| `model` | yes | `{ "tier" }` — see below |
| `memory` | no | `{ "enabled": true, "namespace": "<packageId>/<agentId>" }` — namespace defaults to `<packageId>/<agentId>` |
| `permissions` | no | Domain-neutral keys, all default `false` |
| `outputSchema` | no | Optional JSON Schema the agent's structured output must satisfy |

HR Planner (`fixtures/Corporate-Onboarding.workforce/agents/hr-planner/agent.json`):

```json
{
  "id": "hr-planner",
  "name": "HR Planner",
  "role": "Gathers new-hire details and sequences the first-week onboarding plan.",
  "systemPrompt": "prompt.md",
  "skills": ["onboarding"],
  "model": { "tier": "medium" },
  "memory": { "enabled": true },
  "permissions": { "canAccessHistory": false }
}
```

**`model`** — `tier` (required) ∈ `"small" | "medium" | "large"`; the platform maps the tier to an
available provider (`small` may be a local model, `large` implies a frontier model). Optional:
`preferredProvider` (e.g. `"ollama"`), `preferredModel`, `temperature` (0–2). Buddy is `small`, HR
Planner and Manager Review `medium`, Compliance `large`.

**`permissions`** — deliberately **domain-neutral**; all default `false`, enforced by the runtime:
`canSeeAnswers`, `canGrade`, `canAccessHistory`, `network`.

**`systemPrompt` file** — holds base instructions; capability belongs here or in skills, never in
platform code:

```markdown
You are the HR Planner agent in an onboarding workforce.
Your job is to turn a new hire's details and their manager's expectations into a
concrete, sequenced onboarding plan for the first two weeks: equipment, accounts,
introductions, and a checklist of things to sign.
```

---

## 4. Skills

Skills use the **Agent Skills** format (`agentskills.io`): a `SKILL.md` with YAML frontmatter
(manifest) + a Markdown body (instructions). Schema: `packages/core/schemas/skill.schema.json`
validates only the frontmatter — the body is the skill's instructions.

- `name` (required) must **match the skill folder name**: `skills/onboarding/SKILL.md` declares
  `name: onboarding`.
- `description` is required; `version`, `license`, `allowed-tools` are optional.
- FlowForge-specific fields live under `metadata` (open extension map): `displayName`, `prompts`,
  `tools`, `embeddings` (documents to embed into equipped agents' memories), `dependencies`,
  `compatibleAgents`.
- Agents reference skills by `name`, so keep names stable across versions.

`fixtures/Corporate-Onboarding.workforce/skills/onboarding/SKILL.md`:

```markdown
---
name: onboarding
description: "Standard corporate onboarding: plan, welcome, compliance and manager approval steps."
version: 1.0.0
metadata:
  displayName: Corporate Onboarding
  compatibleAgents:
    - hr-planner
    - buddy
    - compliance
    - manager-review
---

# Onboarding Skill

Conventions for every agent in this workforce:

- A person is a *new hire*, not a *learner* or *student*.
- Days run from the agreed *start date*; always state the weekday.
- Paperwork goes through the Compliance agent before accounts are created.
- The human roles are `hr`, `employee`, `compliance-officer` and `manager`.
- Keep every output short enough to read on a phone screen.
```

This is where the domain's vocabulary lives — the education package does the same, scoping what is
in/out of scope in its algebra skill and pointing `metadata.embeddings` at `knowledge/algebra-notes.md`.

---

## 5. Personas

A persona layers **interaction style and decision policy on top of capability** — the same agent can
be a Supportive Mentor or a Strict Examiner without touching its skills, tools or memory. Schema:
`packages/core/schemas/persona.schema.json`.

| Field | Required | Type / rule |
| --- | --- | --- |
| `id` | yes | `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `name` | yes | Human name |
| `description` | no | Free text |
| `tone` | no | Short tone description, e.g. `"warm and approachable"` |
| `promptOverlay` | yes | Prompt text (or a relative `.md` path) **appended** to the agent's system prompt |
| `decisionPolicy` | no | `{ "strictness", "givesDirectAnswers", "encouragementLevel" }` |
| `compatibleAgents` | no | Agent ids this persona may be applied to; **empty means any** |

`fixtures/Corporate-Onboarding.workforce/personas/supportive-buddy.json`:

```json
{
  "id": "supportive-buddy",
  "name": "Supportive Buddy",
  "description": "Warm, encouraging welcome-guide persona for the Buddy agent.",
  "tone": "warm and approachable",
  "promptOverlay": "Be generous with reassurance. Assume the new hire is excited and slightly nervous. Celebrate small wins ('you got your laptop working — great!').",
  "decisionPolicy": {
    "strictness": "lenient",
    "givesDirectAnswers": true,
    "encouragementLevel": "high"
  },
  "compatibleAgents": ["buddy"]
}
```

`decisionPolicy` is interpreted by the runtime, not package code: `strictness` ∈
`lenient | balanced | strict`, `givesDirectAnswers` (bool), `encouragementLevel` ∈
`low | medium | high`. An agent adopts a persona via `defaultPersona` (Buddy does this); a workflow
agent node can override per step, and `flowforge run --persona <id>` overrides at run time.

---

## 6. Workflows

A workflow is a **declarative spec** — it says *what* happens, not *how* — portable across runners
(embedded in-process and Dapr Workflows). Schema: `packages/core/schemas/workflow.schema.json`;
required `id`, `name`, `start`, `nodes`; `state` is optional but both reference packages declare it
up front — state is *transactional workflow data* (engine-owned), distinct from agent memory.

```json
{
  "id": "onboarding",
  "name": "New Hire Onboarding",
  "start": "collect-details",
  "nodes": [ ... ]
}
```

(Each node writes its result into a `state` variable declared up front, e.g. `plan`,
`complianceReport`, `managerNote` — all initialised to `null`.)

### Node types

Every node has `id` and `type` (`agent | humanInput | humanApproval | branch | parallel | end`);
`next` names the following node (not used by `branch`/`end`).

**`agent`** — required `agent`, `action`; optional `persona`, `inputs` (state variables passed as
context), `output` (state variable storing the result), `retry: { "maxAttempts": n }` (default `1`),
and `memoryWrite` (array of `{ namespace?, text }`; `text` required, `namespace` defaults to the
agent's memory namespace — e.g. the Reflection agent in `revision.json` writes `"Revision cycle
takeaway: {{reflection}}"` to `grade7-maths/student-history`). The onboarding workflow's `plan` node
routes `inputs: ["details"]` through the `hr-planner` agent into `output: "plan"` with
`retry: { "maxAttempts": 2 }`.

**`humanInput`** — required `role`, `output`; optional `prompt`, storing the human's reply in
`output`. *Human-in-the-loop is a first-class node type*: the run pauses (`waitingForHuman`) and
resumes only when an authenticated `Principal` whose roles match `role` supplies input.

**`humanApproval`** — required `role`; optional `subject` (state variable under review), `onApprove`
(next node when approved; defaults to `next`), `onReject` (next node when rejected).

```json
{
  "id": "compliance-approval",
  "type": "humanApproval",
  "role": "compliance-officer",
  "subject": "complianceReport",
  "onApprove": "manager-review",
  "onReject": "compliance-fix"
}
```

**`branch`** — required `conditions`: array of `{ "when", "next" }`. `when` is an expression over
state, e.g. `"score >= 50"`, or the literal `"default"`. **Every branch MUST end with a `default`
condition** — `flowforge validate --graph` fails otherwise. (No fixture workflow uses a branch yet,
but the rule is enforced at graph validation.)

**`parallel`** — required `branches`: at least two node ids, each starting a branch.
**`end`** — terminal; just `{ "id": ..., "type": "end" }`.

### The loop-back pattern

Human-in-the-loop naturally produces revision cycles. In `onboarding.json`, the compliance officer's
rejection loops back into a fix step that re-enters the compliance agent:
`compliance-approval.onReject` → `compliance-fix` (a `humanInput` by `role: "hr"` recording what the
new hire has now provided) → `next: "compliance-check"`. The same pattern appears in `assignment.json`
(teacher approval `onReject` → `student-work`) and the onboarding manager gate (`manager-approval`
`onReject` → `welcome-guide`). Approval routing is *data*, not code.

---

## 7. Validation & running

Build first (`pnpm build`), then use `node packages/cli/dist/index.js` (or the `flowforge` binary).

```bash
# schema validation (all artefacts, cross-references)
node packages/cli/dist/index.js validate fixtures/Corporate-Onboarding.workforce

# schema + graph checks: reachability from `start`, no dangling `next`, every branch has
# a `default`. Exit 1 on failure (CI-friendly).
node packages/cli/dist/index.js validate fixtures/Corporate-Onboarding.workforce --graph

# show the roster: agents (with model tier), skills, personas, workflows
node packages/cli/dist/index.js inspect fixtures/Corporate-Onboarding.workforce

# run headlessly with the mock provider — `--answers answers.json` is an ordered list of
# scripted responses, one per human step, in the order the nodes appear
node packages/cli/dist/index.js run fixtures/Corporate-Onboarding.workforce onboarding --mock --answers answers.json
```

Once runs exist: `runs list`, `audit show` / `audit verify` (hash-chain integrity), `memory list
<packageId>/<agentId>` (e.g. `dev.flowforge.grade7-maths/coach`) and `memory delete`; engine version is
checked at install and by `verify`. The onboarding workflow is fully scriptable in CI (`collect-details`
by `hr`, `new-hire-intro` by `employee`, then the two approvals) — one string per human node in
encounter order.

---

## 8. Packaging, signing & verification (Phase 4)

A `.workforce` directory becomes a distributable archive with `pack`. Archives are **deterministic**:
stable file order and normalised metadata, so building twice from the same source yields identical
bytes — a requirement for signing bytes.

```bash
# 1. generate an Ed25519 signing keypair; private key written to the path
node packages/cli/dist/index.js keygen <key.pem>
# 2. pack into a deterministic archive, optionally signing the manifest
node packages/cli/dist/index.js pack <package-dir> --signing-key <key.pem> --publisher <name>
#    --output <file>   archive path (default: <package-id>-<version>.workforce)
# 3. verify: hash integrity + Ed25519 signature + engine compatibility
node packages/cli/dist/index.js verify <archive.workforce>
# 4. unpack back into a directory (round-trip preserves content exactly)
node packages/cli/dist/index.js unpack <archive.workforce> [--output <dir>]
```

What a signature proves — and what it does **not**:
- The **hash manifest** proves **integrity** (no file changed since packing); the **signature** proves
  **authenticity** (who published it — the signer's fingerprint is embedded and reported by `verify`).
- It does **not** prove the content is *good*. Signing is not review — an author can sign a broken or
  malicious package; verification only means the bytes are exactly what the signer published.

The manifest's `signing` object (`algorithm` / `signature` / `publisher`) is the schema placeholder
for this provenance; actual signing happens at pack time via `--signing-key`.

---

## 9. New domain checklist

Distilled from building the Corporate-Onboarding package — the **second consumer** of the format,
there to prove the abstractions are right:

1. **Pick a domain and a package id.** Reverse-DNS, e.g. `com.example.<domain>`. Set `specVersion:
   "1.0"`, `version` (semver), `engineVersion` (e.g. `">=0.1.0"`), `domain`, `name`, `description`,
   `authors`, `license`.
2. **Name agents and workflows in neutral role language.** `hr-planner`, `compliance`, `buddy`,
   `manager-review`; workflows like `onboarding` — nothing assuming education or any other vertical.
   Human roles on nodes (`hr`, `employee`, `compliance-officer`, `manager`) are the RBAC vocabulary
   matched against `Principal` roles.
3. **Keep domain terms inside package content — never in platform code.** Vocabulary, conventions,
   scope and rules live in `SKILL.md`, `prompt.md` and `knowledge/` (compare the onboarding skill's "a
   person is a *new hire*, not a *learner* or *student*"). Wanting an `if (domain === ...)` in platform
   code means the fix belongs in the schema or the package, not the engine.
4. **Declare agents** (role, systemPrompt, skills, model tier, memory, permissions), a skill they
   share, personas for interaction style, and knowledge to embed into specific agents' memories; add
   `rubrics` only if the domain uses them.
5. **Declare workflows** with human-in-the-loop first-class: start with a `humanInput`, route through
   agent steps, gate on `humanApproval`, loop back into a fix step on `onReject`. Ensure every
   `branch` ends in `default`.
6. **Run `flowforge validate --graph`** until it exits 0 — every node reachable from `start`, no
   dangling `next`, branches have defaults — then **run the package headlessly** with the mock
   provider and `--answers`, and run both reference packages side by side to confirm isolated memory
   namespaces and audit chains.
7. **Pack + sign + verify.** `keygen`, `pack --signing-key --publisher`, `verify`, and confirm a
   tampered archive is rejected.

The Corporate-Onboarding package is the worked proof of domain-agnosticism: four agents, one skill,
one persona, one workflow (two human approvals, two loop-backs), plus a knowledge handbook embedded
into the Buddy and Compliance agents — all running on the same schemas, engine and CLI as the
education package. Scaffold your third package from it and from the checklist above.
