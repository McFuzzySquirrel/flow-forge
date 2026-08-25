/**
 * Shared types for the Dapr Workflows runner (Phase 4.3).
 *
 * The runner is split into a worker side (registers the workflow + activities
 * on a {@link WorkflowRuntime}) and a client side (drives instances via a
 * {@link DaprWorkflowClient}). The two sides only share state through a
 * {@link RunStore}, which is swappable: an in-memory store for tests, the Dapr
 * state store in a hosted deployment.
 */
import type { WorkflowRun } from '@flowforge/workflow';

/** Name of the external event that carries human-input/approval responses. */
export const HUMAN_TASK_EVENT = 'human-task';

/** Activity names registered by the worker. */
export const Activities = {
  save: 'flowforge.save-run',
  agentStep: 'flowforge.agent-step',
  humanStep: 'flowforge.human-step',
  memoryWrite: 'flowforge.memory-write'
} as const;

/** Async run-state store shared by the orchestrator (writes) and client (reads). */
export interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  load(runId: string): Promise<WorkflowRun | undefined>;
}

/** In-memory store used by tests and single-process deployments. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, WorkflowRun>();

  async save(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async load(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

/**
 * The subset of @dapr/dapr's client API the runner depends on — declared as an
 * interface so tests can supply an in-process fake and the production code can
 * supply a real DaprClient.
 */
export interface DaprStateClientLike {
  state: {
    save(storeName: string, states: Array<{ key: string; value: string }>): Promise<void>;
    get(storeName: string, key: string): Promise<{ data?: string } | undefined>;
  };
}

/** Minimal DaprWorkflowClient surface the client-side runner needs. */
export interface DaprWorkflowClientLike {
  scheduleNewWorkflow(
    workflowName: string,
    input?: unknown,
    instanceId?: string
  ): Promise<string>;
  raiseEvent(instanceId: string, eventName: string, eventPayload?: unknown): Promise<void>;
  waitForWorkflowStart(
    instanceId: string,
    fetchPayloads?: boolean,
    timeoutInSeconds?: number
  ): Promise<{ runtimeStatus: string } | undefined>;
}
