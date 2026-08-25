# Dapr Workflows runner

Phase 4.3 turns the declarative `workflow.schema.json` into a **portable
execution contract**: the same JSON that the embedded engine interprets also
runs on a Dapr Workflows runner. One spec, two runners.

- `@flowforge/workflow` exports the `WorkflowRunner` interface
  (`start` / `resume` / `query`), an `EmbeddedWorkflowRunner` (the reference
  implementation), and the shared `runConformanceSuite`.
- `@flowforge/dapr-runner` provides the Dapr implementation:
  - `DaprWorkflowRunner` — the client side. Schedules workflow instances,
    delivers human tasks as Dapr **external events**, and queries run state.
  - `registerDaprWorkflows` — the worker side. Registers each declarative
    workflow as a Dapr workflow (agent nodes → activities, human nodes →
    `waitForExternalEvent`) on a `WorkflowRuntime`.
  - `DaprStateStoreAdapter` — persists run snapshots in a Dapr state store so
    the client and worker agree on state across processes.

## How it maps

| FlowForge concept | Dapr concept |
| --- | --- |
| `waitingForHuman` | orchestrator parked on `ctx.waitForExternalEvent('human-task')` |
| `human.input` / `human.approval` resume | `DaprWorkflowClient.raiseEvent(instanceId, 'human-task', response)` |
| agent step | a `flowforge.agent-step` activity (side effects live in activities, so the orchestrator replays deterministically) |
| workflow state (`run.state`) | JSON run snapshots in the run store |
| ADR-0010 authorization | enforced in `DaprWorkflowRunner.resume` before the event is raised (same `authorizeHumanStep` as the embedded engine) |

Because the orchestrator never performs non-deterministic work directly, the
declarative JSON avoids the classic durable-execution replay pitfalls (no
`Date.now`, no random, no I/O in orchestration code) almost by construction.

## The conformance suite

`packages/workflow/src/conformance.ts` drives any `WorkflowRunner` through the
reference human-in-the-loop scenario and asserts the same observable contract:

- status transitions (`waitingForHuman` at each human node, `completed` at the end)
- pending-task roles in order
- state mutations after each human response
- an intact audit hash chain

Both the embedded runner and the Dapr runner pass it. The Dapr test
(`packages/dapr-runner/src/index.test.ts`) executes the real orchestrator
against an in-process Dapr executor, so the translation is exercised without a
sidecar:

```bash
pnpm vitest run packages/workflow packages/dapr-runner
```

## Running against a live Dapr stack

```bash
docker compose -f docker/docker-compose.yml up --build
```

This starts Redis (Dapr state store), Chroma (vector memory) and a FlowForge
worker with a `daprd` sidecar that serves every workflow in
`fixtures/Grade7-Maths.workforce`. To drive a run from a separate container,
point a `DaprWorkflowRunner` at the sidecar (`DAPR_HTTP_PORT=3500`,
`DAPR_GRPC_PORT=50001`) — it reads run snapshots from the same Redis-backed
store the worker writes to. The embedded and Dapr runners produce identical
observable behavior, verified by the conformance suite above.

## Exit criteria status

- `WorkflowRunner` extracted; embedded engine passes the conformance suite. ✔
- Assignment workflow passes the conformance suite on the Dapr runner (in-process
  executor; a live sidecar run uses the same orchestrator code). ✔
- State/audit adapters: `DaprStateStoreAdapter` (audit contract unchanged —
  both runners record into `AuditLog`). ✔
- Docker Compose stack + worker entrypoint. ✔
