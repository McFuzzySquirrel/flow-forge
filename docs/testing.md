# FlowForge Testing Guide

This guide covers the current test suite, how to run tests, how to write new tests, and — most importantly — how to exercise the system against real LLM providers (Ollama, OpenAI, or any OpenAI-compatible endpoint) instead of the built-in mock.

---

## Quick start

```bash
pnpm install
pnpm build   # required before running tests
pnpm test    # run the full suite
```

All tests use [Vitest](https://vitest.dev/) and run in a Node.js environment.  The root `vitest.config.ts` picks up every `*.test.ts` file under `packages/*/src/` and `packages/*/test/`.

---

## What is tested today

| Package | Test file | What it covers |
|---|---|---|
| `@flowforge/core` | `src/validate.test.ts` | All seven JSON schemas — valid and invalid manifests, agent defs, skill frontmatter, workflow node discriminators, identity config |
| `@flowforge/workforce-packages` | `src/index.test.ts` | Loading and cross-reference validation of the `Grade7-Maths.workforce` fixture; `parseSkillFile` happy path and error cases |
| `@flowforge/agents` | `src/runtime.test.ts` | `AgentRuntime.step` — structured output parsing, persona overlay injection, skill instruction inclusion, memory recall as audit evidence, unknown-agent rejection, `writeMemory` |
| `@flowforge/memory` | `src/index.test.ts` | Namespace scoping, semantic recall, `forget`, `list` |
| `@flowforge/audit` | `src/index.test.ts` | Hash-chain construction and verification, tamper detection, schema-valid records |
| `@flowforge/workflow` | `src/index.test.ts` | Full end-to-end assignment lifecycle (5 agent steps + 3 human pauses); rejection/resubmit loop; role enforcement; participant binding; retry/fail; persona override; `evaluateCondition`; `validateGraph` |
| `@flowforge/identity` | `src/index.test.ts` | `RoleMapper`, `PermissionPolicy`, `IdentityRegistry`, `IdentityService` login/refresh/logout/audit, `InMemorySessionStore` TTL |
| `@flowforge/kernel` | `src/index.test.ts` | `FlowForgeKernel` in-memory and file-backed persistence — validate, load, list, remove packages; start/resume runs; OIDC sign-in; role enforcement; audit trail; full assignment walkthrough across two kernel instances |
| `@flowforge/desktop` | `src/kernel.test.ts` | IPC bridge smoke test |

### Running individual packages

```bash
# one package
pnpm --filter @flowforge/workflow test

# watch mode for active development
pnpm vitest
```

### Useful Vitest flags

```bash
# run only tests whose name matches a pattern
pnpm vitest run --reporter=verbose -t "chains records"

# run a single file
pnpm vitest run packages/agents/src/runtime.test.ts
```

---

## Anatomy of a test

Most tests follow a three-step pattern:

1. **Assemble** – load the `Grade7-Maths.workforce` fixture, create a `MockModelProvider` that returns a fixed JSON string, wire up `ModelRegistry`, `MemoryService`, `AuditLog`.
2. **Act** – call the unit under test (e.g. `runtime.step(...)` or `engine.resume(...)`).
3. **Assert** – check the returned value, the audit trail, and any side effects (memory, persisted state).

The helper used throughout the agent and workflow tests:

```ts
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';

function makeRuntime(responder: (systemPrompt: string) => string) {
  const pkg = loadWorkforcePackage('/path/to/Grade7-Maths.workforce');
  const provider = new MockModelProvider((req) => responder(req.messages[0]!.content));
  const models = new ModelRegistry()
    .set('small', provider)
    .set('medium', provider)
    .set('large', provider);
  return new AgentRuntime(pkg, loadWorkforcePackage, models, new MemoryService(), new AuditLog());
}
```

---

## Testing with real LLM providers

All model traffic goes through the `ModelProvider` interface:

```ts
export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
```

Swap `MockModelProvider` for any of the built-in providers — or write your own — to run the same tests (or the CLI) against a real model.

### Provider A — Ollama (local, offline)

[Ollama](https://ollama.com) runs open-source models on your machine over a local HTTP API.

**Setup**

```bash
# install: https://ollama.com/download
ollama pull llama3.2        # ~2 GB; the default model
ollama pull qwen2.5:3b      # lighter alternative (~2 GB)
ollama serve                # keeps the server running (usually starts automatically)
```

**Usage in tests**

```ts
import { OllamaProvider, ModelRegistry } from '@flowforge/agents';

const provider = new OllamaProvider(
  'http://localhost:11434', // default
  'llama3.2'               // model tag — must match a pulled model
);

const models = new ModelRegistry()
  .set('small',  provider)
  .set('medium', provider)
  .set('large',  provider);
```

**What changes with a real model**

- Responses are natural language, not deterministic JSON. The `AgentRuntime` calls `tryParseJson` on the raw response, so an agent that expects structured output (`{ score, confidence }`) may return the raw string instead of a parsed object if the model produces prose.
- Tests that assert on exact output values need to be adapted — either use looser assertions (`expect.stringContaining`) or configure the model with a system prompt that enforces a strict output schema.
- Latency goes from <1 ms (mock) to 2–60 s depending on hardware.

**Suggested approach**: keep the fast unit tests with `MockModelProvider` and add a separate `*.integration.test.ts` file (excluded from the default test run) for real-provider smoke tests:

```ts
// packages/agents/src/runtime.integration.test.ts
import { describe, it } from 'vitest';
import { OllamaProvider, ModelRegistry, AgentRuntime } from './index.js';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

describe.skipIf(!process.env.OLLAMA_BASE_URL)('AgentRuntime — Ollama smoke tests', () => {
  it('calls the assessment agent and gets a non-empty response', async () => {
    const provider = new OllamaProvider(process.env.OLLAMA_BASE_URL, 'llama3.2');
    const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
    const runtime = new AgentRuntime(
      loadWorkforcePackage(fixture),
      models,
      new MemoryService(),
      new AuditLog()
    );

    const result = await runtime.step({
      agentId: 'assessment',
      action: 'Mark the submission',
      inputs: { submission: 'x + 3 = 10 so x = 7' }
    });

    console.log('raw model output:', result.raw);
    expect(result.raw.length).toBeGreaterThan(0);
  }, 60_000); // long timeout for model inference
});
```

Run only the integration tests:

```bash
OLLAMA_BASE_URL=http://localhost:11434 pnpm vitest run --reporter=verbose runtime.integration
```

---

### Provider B — OpenAI (or any OpenAI-compatible API)

`OpenAICompatibleProvider` works with OpenAI, Azure OpenAI, Groq, Together AI, Mistral, LM Studio, or any service that serves the `/v1/chat/completions` endpoint.

**Usage**

```ts
import { OpenAICompatibleProvider, ModelRegistry } from '@flowforge/agents';

// OpenAI
const openai = new OpenAICompatibleProvider(
  'https://api.openai.com/v1',
  process.env.OPENAI_API_KEY!,
  'gpt-4o-mini'
);

// Azure OpenAI (endpoint URL includes the deployment path)
const azure = new OpenAICompatibleProvider(
  'https://<resource>.openai.azure.com/openai/deployments/<deployment>/v1',
  process.env.AZURE_OPENAI_API_KEY!,
  'gpt-4o'
);

// Groq
const groq = new OpenAICompatibleProvider(
  'https://api.groq.com/openai/v1',
  process.env.GROQ_API_KEY!,
  'llama-3.1-8b-instant'
);

// LM Studio (local OpenAI-compatible server)
const lmstudio = new OpenAICompatibleProvider(
  'http://localhost:1234/v1',
  'lm-studio', // LM Studio ignores the key but the header is required
  'local-model'
);

const models = new ModelRegistry()
  .set('small',  openai)
  .set('medium', openai)
  .set('large',  openai);
```

**Using different providers per tier**

Workforce packages specify a model tier per agent (`small`, `medium`, or `large`).  You can map each tier to a different provider — for example, local Ollama for cheap agents and a cloud model for the assessment agent:

```ts
import { OllamaProvider, OpenAICompatibleProvider, ModelRegistry } from '@flowforge/agents';

const models = new ModelRegistry()
  .set('small',  new OllamaProvider('http://localhost:11434', 'qwen2.5:3b'))
  .set('medium', new OllamaProvider('http://localhost:11434', 'llama3.2'))
  .set('large',  new OpenAICompatibleProvider('https://api.openai.com/v1', process.env.OPENAI_API_KEY!, 'gpt-4o'));
```

---

### Provider C — Writing a custom provider

Implement the two-method interface:

```ts
import type { ModelProvider, CompletionRequest, CompletionResponse } from '@flowforge/agents';

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel = 'claude-3-haiku-20240307'
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel;

    // Anthropic messages API differs slightly: system prompt is a top-level field
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, system, messages, max_tokens: 1024 })
    });

    if (!response.ok) throw new Error(`Anthropic request failed: ${response.status}`);
    const data = (await response.json()) as { content: { text: string }[] };
    return { content: data.content[0]!.text, model };
  }
}
```

Pass it to a `ModelRegistry` exactly like any other provider.

---

## Using real providers through the CLI

The CLI's `--mock` flag uses `MockModelProvider`. To run against a real provider, omit `--mock` and set environment variables:

```bash
# Ollama (default, no key required)
export FLOWFORGE_PROVIDER=ollama
export FLOWFORGE_OLLAMA_URL=http://localhost:11434
export FLOWFORGE_OLLAMA_MODEL=llama3.2
flowforge run fixtures/Grade7-Maths.workforce assignment

# OpenAI-compatible
export FLOWFORGE_PROVIDER=openai
export FLOWFORGE_OPENAI_URL=https://api.openai.com/v1
export FLOWFORGE_OPENAI_API_KEY=sk-...
export FLOWFORGE_OPENAI_MODEL=gpt-4o-mini
flowforge run fixtures/Grade7-Maths.workforce assignment
```

> **Note:** full CLI provider selection (the environment-variable lookup described above) is a planned enhancement — the current CLI always uses the mock provider. See the Phase 3 / Phase 4 roadmap in `docs/PLAN.md`. For now, instantiate providers directly in code or integration tests.

---

## Environment variables reference

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `OLLAMA_BASE_URL` | integration tests | — | Skips Ollama tests when unset (`describe.skipIf`) |
| `OPENAI_API_KEY` | integration tests | — | OpenAI API key |
| `AZURE_OPENAI_API_KEY` | integration tests | — | Azure OpenAI API key |
| `GROQ_API_KEY` | integration tests | — | Groq API key |

---

## Structuring integration tests

The recommended pattern keeps unit tests (fast, always run) and integration tests (slow, optional) in separate files, using Vitest's `describe.skipIf` guard:

```ts
// Skip the whole suite unless the env var is present
describe.skipIf(!process.env.OPENAI_API_KEY)('Assessment — OpenAI integration', () => {
  it('returns structured JSON for a one-step equation submission', async () => {
    // ...
  }, 30_000);
});
```

To run only integration tests without changing `vitest.config.ts`:

```bash
OPENAI_API_KEY=sk-... pnpm vitest run --reporter=verbose "*.integration"
```

To include integration tests in CI, add the environment variable as a repository secret and include the flag in your workflow.

---

## Checking test coverage

Vitest has built-in coverage via `@vitest/coverage-v8`:

```bash
pnpm add -D @vitest/coverage-v8   # add once if not already present
pnpm vitest run --coverage
```

The coverage report is written to `coverage/` and a summary is printed to the terminal.

---

## Test artifacts

Some tests write temporary files (run state, kernel persistence tests). These land in `.test-artifacts/` at the repo root, which is git-ignored. The tests clean up after themselves via `afterEach` / `afterAll` hooks.

---

## Adding tests for a new package

1. Create `packages/<name>/src/<name>.test.ts` (or `packages/<name>/test/`).
2. The root `vitest.config.ts` picks it up automatically — no registration needed.
3. Follow the assemble / act / assert pattern, using `MockModelProvider` for any code that calls a model.
4. For side-effecting tests (file I/O, real HTTP), add a `beforeEach` / `afterEach` cleanup block.

---

## Further reading

- [Vitest docs](https://vitest.dev/guide/)
- [Ollama API reference](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [OpenAI API reference](https://platform.openai.com/docs/api-reference/chat)
- [`packages/agents/src/providers.ts`](../packages/agents/src/providers.ts) — `MockModelProvider`, `OllamaProvider`, `OpenAICompatibleProvider`, `ModelRegistry`
- [`docs/PLAN.md`](PLAN.md) — upcoming work including real-provider CLI integration
