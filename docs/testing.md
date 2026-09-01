# FlowForge Testing Guide

How FlowForge is tested, how to run the suite, and how to write tests — including
how to exercise the system against real LLM providers and live infrastructure
(Ollama, OpenAI-compatible endpoints, Chroma, a Dapr sidecar) instead of the
built-in mocks.

---

## Quick start

```bash
corepack pnpm install
corepack pnpm -r build   # compile the workspace first — tests import the compiled packages
corepack pnpm test       # run the full suite (offline, mock models only)
```

The full suite is **fast, deterministic and offline** — every model call goes
through `MockModelProvider` unless you opt into a real provider. On a typical
machine it completes in a few seconds.

All tests run under [Vitest](https://vitest.dev/). The root `vitest.config.ts`
discovers every `*.test.ts` under `packages/*/src/` and `packages/*/test/`, so a
new test file needs no registration.

---

## The test pyramid

FlowForge tests are layered the way the system is layered:

1. **Unit** — schemas, the workflow engine, the audit hash chain, the memory
   contract suite, identity mapping/sessions. Pure, fast, no I/O beyond a temp
   directory.
2. **Integration** — the pieces that make FlowForge *FlowForge*:
   - the **runner conformance suite** drives both the embedded engine and the
     Dapr runner through the same scripted human-in-the-loop scenario;
   - `.workforce` **pack → verify → unpack round-trips** (determinism, signing,
     tamper rejection);
   - two packages running side-by-side in one kernel with **zero audit/memory
     cross-contamination**;
   - headless CLI runs via `--answers`.
3. **Live / infrastructure** — optional tests that need a real model or service.
   These are gated with `describe.skipIf(...)` on an environment variable, so
   they silently skip in CI and for anyone who hasn't provisioned the service.

Keep the default suite fast. Put anything that needs a network or a Docker
container behind a skip-guard, never in the default path.

---

## Running tests

```bash
pnpm test                                     # the whole suite
pnpm vitest run packages/agents/src/runtime.test.ts   # one file
pnpm vitest run -t "chains records"          # by test name
pnpm vitest run --reporter=verbose           # per-test output
pnpm vitest                                   # watch mode while developing
```

Notes:

- Tests are run from the repo root. There is **no `test` script on individual
  packages** — use the root commands above.
- Many tests load fixtures by resolving `../../../fixtures/...` from
  `import.meta.url`, so they work regardless of your current directory.

---

## What's tested today

| Package | Test file(s) | Covers |
|---|---|---|
| `@flowforge/core` | `src/validate.test.ts` | All JSON schemas (workforce-package incl. `engineVersion`, agent, skill, persona, workflow, audit-record, identity) — valid and invalid documents, node discriminators |
| `@flowforge/packages` (workforce-packages) | `src/index.test.ts` | Loading and cross-reference validation of the fixtures; `parseSkillFile` happy path and error cases |
| `@flowforge/agents` | `src/runtime.test.ts`, `src/providers.test.ts` | `AgentRuntime.step` (structured output, persona overlay, skill instructions, memory recall as evidence), `writeMemory`, provider classes |
| `@flowforge/memory` | `src/index.test.ts` | Shared `VectorStore` contract suite (in-memory + file), namespace isolation, `MemoryService` recall/forget/list, retention/decay (`maxItems`, `maxAgeMs`) |
| `@flowforge/audit` | `src/index.test.ts` | Hash-chain construction, verification, tamper detection, schema-valid records |
| `@flowforge/workflow` | `src/index.test.ts`, `src/conformance.test.ts` | End-to-end assignment lifecycle, rejection/resubmit loop, role enforcement + participant binding (ADR-0010), retries/fail, persona override, `evaluateCondition`, `validateGraph`, the embedded runner passing the conformance suite |
| `@flowforge/identity` | `src/index.test.ts` | `RoleMapper`, `PermissionPolicy`, `IdentityRegistry`, `IdentityService` login/refresh/logout + audited denials, session TTL, and the OAuth config alias for discovery-backed providers |
| `@flowforge/kernel` | `src/index.test.ts`, `src/isolation.test.ts` | `FlowForgeKernel` in-memory + file-backed persistence, package install from signed/unsigned/tampered `.workforce` archives, `engineVersion` rejection, OAuth/OIDC token sign-in, workflow save + agent-skill persistence, model-config updates, kernel messaging, the full assignment walkthrough, and **two packages side-by-side with zero cross-contamination** |
| `@flowforge/packaging` | `src/index.test.ts` | Deterministic ZIP writer/reader, canonical JSON, Ed25519 signing, pack/unpack round-trips, `verifyWorkforceArchive` (hashes, signature, engine compat), path-traversal guard |
| `@flowforge/dapr-runner` | `src/index.test.ts` | The Dapr runner passing the **same conformance suite** as the embedded engine via an in-process Dapr executor; authorization on resume; `DaprStateStoreAdapter` round-trips |
| `@flowforge/cli` | `src/config.test.ts`, `src/setup.test.ts`, `src/pack.test.ts` | Config precedence + secrets handling, interactive/non-interactive setup, `pack`/`unpack`/`verify` command behavior |
| `@flowforge/desktop` | `src/kernel.test.ts` | Desktop-kernel smoke coverage over the kernel/provider wiring with deterministic mock models |

---

## Anatomy of a test

Most tests follow assemble → act → assert:

1. **Assemble** — load a fixture package, create a `MockModelProvider` that
   returns a fixed JSON string, wire a `ModelRegistry`, `MemoryService` and
   `AuditLog`.
2. **Act** — call the unit under test (`runtime.step`, `engine.resume`,
   `kernel.startRun`, …).
3. **Assert** — check the return value, the audit trail, and any side effects
   (memory, persisted run state).

The helper used throughout the agent/workflow/kernel tests:

```ts
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';

function makeRuntime(responder: (systemPrompt: string) => string) {
  const pkg = loadWorkforcePackage('/path/to/Grade7-Maths.workforce');
  const provider = new MockModelProvider((request) =>
    responder(request.messages[0]!.content)
  );
  const models = new ModelRegistry()
    .set('small', provider)
    .set('medium', provider)
    .set('large', provider);
  return new AgentRuntime(pkg, models, new MemoryService(), new AuditLog());
}
```

`MockModelProvider` takes a single callback `(request: CompletionRequest) => string`
and returns that string as the model completion — perfect for scripting agent
responses that parse as structured JSON (`{ "score": 82, "confidence": 0.9 }`).

---

## The runner conformance suite

FlowForge's workflows run on two runners: the embedded in-process engine and
the Dapr Workflows runner. **One spec, two runners** is enforced by
`runConformanceSuite` in `packages/workflow/src/conformance.ts`:

- it drives any `WorkflowRunner` through the same scripted scenario (status
  transitions, pending-task roles in order, state mutations, intact audit chain);
- `packages/workflow/src/conformance.test.ts` runs it against the embedded
  engine;
- `packages/dapr-runner/src/index.test.ts` runs it against `DaprWorkflowRunner`
  using an in-process Dapr executor (no sidecar required) — so the workflow→Dapr
  translation is exercised in CI.

Any future runner just calls the same suite.

---

## Testing with real LLM providers

All model traffic goes through the two-method `ModelProvider` interface
(`name` + `complete(request)`). Swap `MockModelProvider` for a real provider to
run the same code against a real model. A good pattern is to keep the fast unit
tests on the mock and add a separate `*.integration.test.ts` file for smoke
tests.

### Ollama (local, offline)

```bash
ollama pull llama3.2        # ~2 GB; the default model
ollama pull qwen2.5:3b      # lighter alternative
ollama serve                # usually starts automatically
```

```ts
import { OllamaProvider, ModelRegistry } from '@flowforge/agents';

const models = new ModelRegistry()
  .set('small', new OllamaProvider('http://localhost:11434', 'qwen2.5:3b'))
  .set('medium', new OllamaProvider('http://localhost:11434', 'llama3.2'))
  .set('large', new OllamaProvider('http://localhost:11434', 'llama3.2'));
```

```ts
// packages/agents/src/runtime.integration.test.ts
describe.skipIf(!process.env.OLLAMA_BASE_URL)('AgentRuntime — Ollama smoke', () => {
  it('gets a non-empty response', async () => {
    const provider = new OllamaProvider(process.env.OLLAMA_BASE_URL!, 'llama3.2');
    const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
    const runtime = new AgentRuntime(
      loadWorkforcePackage(fixture), models, new MemoryService(), new AuditLog()
    );
    const result = await runtime.step({
      agentId: 'assessment',
      action: 'Mark the submission',
      inputs: { submission: 'x + 3 = 10 so x = 7' }
    });
    expect(result.raw.length).toBeGreaterThan(0);
  }, 60_000); // model inference is slow
});
```

Run only the integration tests:

```bash
OLLAMA_BASE_URL=http://localhost:11434 pnpm vitest run "*.integration"
```

### OpenAI-compatible endpoints (incl. DeepSeek)

`OpenAICompatibleProvider` works with OpenAI, Azure OpenAI, Groq, Together AI,
LM Studio — anything that serves `/v1/chat/completions`. DeepSeek ships as its
own `DeepSeekProvider`.

```ts
const models = new ModelRegistry()
  .set('small', new OpenAICompatibleProvider('https://api.openai.com/v1', process.env.OPENAI_API_KEY!, 'gpt-4o-mini'))
  .set('medium', new OpenAICompatibleProvider('https://api.openai.com/v1', process.env.OPENAI_API_KEY!, 'gpt-4o-mini'))
  .set('large', new OpenAICompatibleProvider('https://api.openai.com/v1', process.env.OPENAI_API_KEY!, 'gpt-4o'));

// Or mix: cheap local agents, frontier model for assessment
const hybrid = new ModelRegistry()
  .set('small', new OllamaProvider('http://localhost:11434', 'qwen2.5:3b'))
  .set('large', new OpenAICompatibleProvider('https://api.openai.com/v1', process.env.OPENAI_API_KEY!, 'gpt-4o'));
```

### A custom provider

Implement the two-method interface and pass it to a `ModelRegistry` like any
other provider:

```ts
import type { ModelProvider, CompletionRequest, CompletionResponse } from '@flowforge/agents';

export class MyProvider implements ModelProvider {
  readonly name = 'my-provider';
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // ... call your endpoint ...
    return { content: '…', model: 'my-model' };
  }
}
```

### What changes with a real model

- Responses are prose, not deterministic JSON. The runtime calls `tryParseJson`
  on the raw response, so tests that assert exact structured output may need
  looser assertions or a system prompt that enforces a strict output schema.
- Latency goes from <1 ms (mock) to seconds.

---

## Live infrastructure tests

The same `describe.skipIf(envVar)` pattern gates tests that need Docker
services:

```ts
describe.skipIf(!process.env.CHROMA_URL)('ChromaVectorStore — integration', () => {
  it('adds and recalls items', async () => {
    const store = new ChromaVectorStore(new MockEmbeddingProvider(), process.env.CHROMA_URL);
    await store.add('test/ns', { id: '1', text: 'fractions lesson', createdAt: new Date().toISOString() });
    const results = await store.query('test/ns', 'fractions', 5);
    expect(results.length).toBeGreaterThan(0);
  });
});
```

- **Chroma** — `docker run -p 8000:8000 chromadb/chroma`; gate on `CHROMA_URL`.
- **Dapr** — start the hosted stack (`docker compose -f docker/docker-compose.yml up --build`) and point a runner at the sidecar. The default suite already exercises the Dapr orchestrator translation through the in-process executor, so a live sidecar is only needed for a true end-to-end smoke.

---

## Environment variables reference

| Variable | Used by | Effect |
|---|---|---|
| `OLLAMA_BASE_URL` | `*.integration` tests | Enables Ollama smoke tests when set |
| `OPENAI_API_KEY` | `*.integration` tests | Key for OpenAI-compatible providers |
| `CHROMA_URL` | `*.integration` tests | Enables Chroma integration tests when set |
| `FLOWFORGE_PROVIDER` | CLI provider resolution | Default provider (`ollama`/`deepseek`/`openai`/`hybrid`) when no `--provider` flag or config is present |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | CLI | Cloud API keys; also written by `flowforge setup` to the git-ignored `.env` |

---

## Coverage

Vitest coverage uses `@vitest/coverage-v8` (install once, then run):

```bash
pnpm add -D @vitest/coverage-v8
pnpm vitest run --coverage
```

The report is written to `coverage/` and summarized in the terminal.

---

## Test artifacts

Tests that write files (run state, kernel persistence, archive round-trips) use
a temp directory under `.test-artifacts/` at the repo root (git-ignored) and
clean up after themselves via `afterEach`.

---

## Adding tests for a new package

1. Create `packages/<name>/src/<name>.test.ts` — root `vitest.config.ts` picks
   it up automatically.
2. Follow assemble → act → assert, using `MockModelProvider` for any code that
   calls a model.
3. For side-effecting tests (file I/O, real HTTP), add `beforeEach`/`afterEach`
   cleanup and use `describe.skipIf` when a service is required.
4. Run it with `pnpm vitest run packages/<name>` and then the full suite with
   `pnpm test`.

---

## Further reading

- [Vitest docs](https://vitest.dev/guide/)
- [User guide](user-guide.md) — running the platform day-to-day
- [Package author guide](authoring-packages.md) — authoring `.workforce` packages
- [Dapr runner](dapr-runner.md) — the second workflow runner
