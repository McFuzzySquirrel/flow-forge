# FlowForge User Guide

This guide is for anyone who wants to **install and use FlowForge** — no need to
read the source. You'll set up the platform, install a workforce package, run a
workflow with human-in-the-loop steps, inspect the audit trail, and try the
desktop app.

> **Prefer the UI?** Jump to [The desktop app](#the-desktop-app). Everything in
> the CLI below is also available in the app.

---

## What FlowForge is

FlowForge is an **agent workforce platform**. The platform itself knows nothing
about any specific domain. Instead, you install a **workforce package** — a
`.workforce` folder — and it brings a complete team to life:

- **`Grade7-Maths.workforce`** — a classroom: Planner, Curriculum, Assessment,
  Feedback and Teacher agents that run a full assignment lifecycle with a
  teacher and a student in the loop.
- **`Corporate-Onboarding.workforce`** — a company: HR-Planner, Buddy,
  Compliance and Manager-Review agents that onboard a new hire with HR,
  employee, compliance-officer and manager steps.

Same software, different worlds. Install a package, pick a workflow, and the
agents, skills, personas, approvals and audit trail all come from the package —
**nothing is hardcoded in the platform**.

---

## Install (one time)

Requirements: **Node.js 20+** and [pnpm](https://pnpm.io) (the exact version is
pinned by the project). Git is needed to fetch the repo.

```bash
git clone https://github.com/McFuzzySquirrel/flow-forge.git
cd flow-forge

# 1. Enable pnpm and install everything
corepack enable && corepack prepare pnpm@11.5.2 --activate
pnpm install

# 2. Compile all packages (takes a minute)
pnpm build

# 3. Sanity check — the test suite is fast and fully offline
pnpm test
```

**Making `flowforge` a command.** `pnpm install` links the CLI binary into
`node_modules/.bin/`, so **`pnpm exec flowforge …` works inside the repo with no
extra steps** (the examples below use `flowforge` to keep them short — read it
as `pnpm exec flowforge`). For a system-wide `flowforge` you can type anywhere,
run this once:

```bash
pnpm setup            # add pnpm's global bin directory to your shell PATH
pnpm link --global ./packages/cli
```

then open a new terminal — bare `flowforge …` works from anywhere.

> Every `flowforge` command below means `pnpm exec flowforge …` (from the repo)
> or the globally-linked `flowforge` — both are the same `node packages/cli/dist/index.js`.

---

## 5-minute quickstart (no API keys, no Docker)

FlowForge ships with a **mock model provider** so you can try everything
immediately — no Ollama, no OpenAI key, no Docker.

Run a full classroom assignment workflow headlessly with scripted answers:

```bash
flowforge validate fixtures/Grade7-Maths.workforce
flowforge run fixtures/Grade7-Maths.workforce assignment --mock --answers answers.json
```

Where `answers.json` scripts the human steps in order (teacher sets the
assignment → student submits → teacher approves):

```json
[
  { "value": "Solve one- and two-step linear equations, show your working." },
  { "value": "x + 3 = 10, so x = 7" },
  { "approved": true, "reason": "Correct method, well shown." }
]
```

You'll see the run finish with `status: completed`, the audit trail (10 records),
and the run **persisted** to `~/.flowforge`. Check it:

```bash
flowforge runs list
flowforge audit verify
```

That's it — you've run a multi-agent workflow with human approvals and an
immutable, hash-chained audit trail.

---

## Everyday CLI tasks

| Task | Command |
|---|---|
| Validate a package (schema + cross-references) | `flowforge validate <package-dir>` |
| Also check the workflow graph (reachability, dangling edges) | `flowforge validate <package-dir> --graph` |
| See a package's agents/skills/personas/workflows | `flowforge inspect <package-dir>` |
| Run a workflow **interactively** (type answers at prompts) | `flowforge run <dir> <workflow-id> --mock` |
| Run a workflow **headlessly** (scripted answers) | `flowforge run <dir> <workflow-id> --mock --answers file.json` |
| Run with a specific persona | `flowforge run <dir> assignment --mock --persona supportive-mentor` |
| Watch progress as it advances | add `--watch` |
| List persisted runs | `flowforge runs list` |
| Show one run | `flowforge runs show <run-id>` |
| View the audit trail | `flowforge audit show` |
| Verify the audit hash chain | `flowforge audit verify` |
| Export audit records as JSON | `flowforge audit export --output audit.json` |
| A/B compare two runs' personas and scores | `flowforge audit show --run <a> --run <b>` |
| List an agent's memory ("what does the coach remember?") | `flowforge memory list <namespace>` |
| Delete a memory item (right to forget) | `flowforge memory delete <namespace> <item-id>` |
| Package a directory into a `.workforce` archive | `flowforge pack <package-dir>` |
| Verify an archive (integrity + signature) | `flowforge verify <archive>` |
| Unpack an archive | `flowforge unpack <archive> --output <dir>` |

### Using a real model provider

The `--mock` flag uses the offline mock. To use real models:

1. Run the interactive setup — it detects your environment, walks you through
   provider (local Ollama or a cloud API), models, vector store and identity,
   and writes a config:

   ```bash
   flowforge setup
   ```

2. Then just drop `--mock` — commands read the config automatically:

   ```bash
   flowforge run fixtures/Grade7-Maths.workforce assignment
   ```

   Flags and environment variables override the config per run
   (`--provider ollama|deepseek|openai|hybrid`, `--api-key`, `--data-dir`).

The desktop app uses the same secret-free config too, so once setup is complete
your desktop runs use the same Ollama/cloud routing as the CLI.

`flowforge doctor` prints a read-only health checklist (Node, pnpm, build,
Ollama, Docker) and exits non-zero if something required is missing.

---

## The desktop app

The desktop app (Electron + React) is the visual version of everything above:

```bash
pnpm --filter @flowforge/desktop dev
```

It opens a window with:

- **Home / Workforce** — install a package (pick it with the **Browse…** button,
  or type a path to a `...workforce` directory or a `.workforce` archive), see
  its branding, agent roster and workflows.
- **Runs** — start a workflow from any installed package, watch live progress,
  answer human-input and human-approval steps, see failure cards, and inspect
  the provider, model, and latest output preview for each agent step.
- **Per-role portals** — one portal per human role in the installed packages
  (Teacher, Student, HR, Employee, Compliance Officer, Manager — whatever the
  package declares). Each shows that role's task inbox and feedback with
  "why?" links straight into the audit record for every mark. Swap the package
  and the portal list changes with it.
- **Audit viewer** — chronological records, a chain-verify button, filters,
  JSON export, and model/output visibility per agent step.
- **Governance** — identity providers, role mappings, model-provider routing,
  config warnings, and a per-user audit table.
- **Workflow editor** — open any workflow as a graph, watch a live run light it
  up, edit nodes, manage an agent's assigned skills, save workflow changes back
  to the installed package, and dry-run the result without leaving the editor.

Sign in either with the built-in **dev identity** (one button per workflow role,
e.g. "Sign in as teacher") or with a real **OAuth/OIDC provider** (configured
via `~/.flowforge/identity.json` or `$FLOWFORGE_IDENTITY_CONFIG`) using
authorization-code + PKCE — the browser opens, you approve, and the app
resumes.

### Desktop model configuration

After running `flowforge setup`, open **Governance** in the desktop app to
review or change the active provider routing:

- choose `ollama`, `deepseek`, `openai`, or `hybrid`
- edit the secret-free URL/model settings written into `flowforge.config.json`
- keep API keys in the environment or `~/.flowforge/.env`
- review any warning shown when a cloud provider is selected without the needed
  API key; in that case FlowForge falls back to the mock provider until the
  configuration is usable

### Saving workflow and agent-skill changes

The workflow editor now supports two kinds of authoring changes against an
installed package:

- **Save workflow** writes the edited workflow JSON back to the package on disk
- **Agent skills** in the property panel updates the referenced agent's
  `skills` list in its `agent.json`

This makes the editor suitable for lightweight package maintenance, not just
visual inspection.

> The desktop app opens an Electron window, so it needs a graphical session.
> The CLI works headless anywhere.

---

## Two worked scenarios

### 1. Classroom: Grade 7 assignment

```bash
flowforge run fixtures/Grade7-Maths.workforce assignment --mock --answers answers.json
```

The human steps, in order:

1. **teacher** sets the assignment brief.
2. **student** submits their work.
3. **teacher** approves (or rejects → back to the student to revise).

The agents in between — Planner, Curriculum, Assessment, Feedback, Teacher
consistency check — all run automatically and emit audit records with scores,
evidence and the rubric section each mark relates to.

### 2. Corporate: new-hire onboarding

```bash
flowforge run fixtures/Corporate-Onboarding.workforce onboarding --mock --answers onboarding-answers.json
```

With `onboarding-answers.json`:

```json
[
  { "value": "Backend Engineer, starts Monday, contract and right-to-work received" },
  { "value": "I am Alex, backend engineer, keen to meet the platform team." },
  { "approved": true, "reason": "Paperwork is in order" },
  { "approved": true, "reason": "Plan covers the first-month goals" }
]
```

Human steps in order: **hr** enters the new hire's details → **employee**
introduces themselves → **compliance-officer** approves (or rejects → HR fixes
the gaps → re-check) → **manager** approves the final plan. The Compliance
agent's PASS/GAP checklist, the Buddy's welcome guide and the Manager-Review
note are all produced by agents defined *in the package* — no platform code
changes.

---

## Where things live on disk

| Path | What it is |
|---|---|
| `~/.flowforge/` | Default data directory: `config.json`, `packages.json` (installed packages), `runs/*.json` (run state), `audit.jsonl` (hash-chained audit log), `memory/` (file-backed vector store) |
| `~/.flowforge/.env` | Secrets (cloud API keys) — git-ignored, never written into config |
| `~/.flowforge/identity.json` | Optional desktop identity-provider configuration for OAuth/OIDC login |
| `flowforge.config.json` | Config; precedence is **flags > env > repo config > user config > defaults** |

You can point everything at a different directory per run with `--data-dir`.

---

## Packaging & signing packages (for authors)

Workforce packages are directories that can be shipped as **deterministic
`.workforce` archives** (building twice yields identical bytes):

```bash
flowforge keygen ~/my-signing.pem                                   # create a signing key once
flowforge pack fixtures/Grade7-Maths.workforce \
  --signing-key ~/my-signing.pem --publisher "Your Name"
flowforge verify dev.flowforge.grade7-maths-1.0.0.workforce          # integrity + authorship
flowforge unpack dev.flowforge.grade7-maths-1.0.0.workforce --output ~/unpacked
```

The hash manifest proves nothing changed; the Ed25519 signature proves who
published it. To author your own package from scratch, follow the
[package author guide](authoring-packages.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Something isn't set up right | `flowforge doctor` — read-only checklist of Node, pnpm, build, Ollama, Docker |
| `run` hangs at a human step | It's waiting for input. Either answer at the prompt or supply `--answers file.json` |
| Run stuck at `waitingForHuman` in CI | The answers file ran out of entries — add one per human step |
| `audit verify` fails | The chain is tampered or two writers wrote to the same log. Investigate before trusting any record |
| "Package is not compatible with engine" | The package declares an `engineVersion` range your build doesn't satisfy — upgrade the engine or use a compatible package |
| Ollama connection refused | `ollama serve`, and confirm the model is pulled (`ollama pull llama3.2`) |
| Chroma/Dapr services missing | Only needed for those integrations — see [Dapr runner](dapr-runner.md) and `docker compose -f docker/docker-compose.yml up --build` |
| Desktop app aborts with a `chrome-sandbox` / SUID sandbox error on Linux | Chromium's sandbox needs a root-owned setuid helper that npm installs rarely provide. The dev harness already passes `--no-sandbox` on Linux; for production set it up once: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` |

---

## Where to go next

- [Package author guide](authoring-packages.md) — build your own workforce
- [Auth identities guide](auth-identities.md) — configure Microsoft Entra ID, Google Workspace, Auth0, Keycloak, or the dev mock provider
- [Testing guide](testing.md) — how the platform is tested and how to wire real models
- [Dapr runner](dapr-runner.md) — running workflows on a hosted Dapr stack
- [Architecture & roadmap](PLAN.md) — the full build plan and design rules
