/**
 * DaprWorkflowRunner — the Dapr Workflows implementation of {@link WorkflowRunner}
 * (Phase 4.3.2). Client side: schedules workflow instances, delivers human
 * tasks as Dapr external events, and queries run state through the shared run
 * store. Authorization (role + participant binding, ADR-0010) is enforced here
 * before an event is raised, mirroring the embedded engine.
 */
import { randomUUID } from 'node:crypto';
import type { AuditLog } from '@flowforge/audit';
import type { WorkflowDefinition } from '@flowforge/core';
import {
  authorizeHumanStep,
  type HumanStepResponse,
  type WorkflowRun,
  type WorkflowRunner,
  type WorkflowStartOptions
} from '@flowforge/workflow';
import { HUMAN_TASK_EVENT, type DaprWorkflowClientLike, type RunStore } from './types.js';

export interface DaprWorkflowRunnerOptions {
  client: DaprWorkflowClientLike;
  runStore: RunStore;
  audit: AuditLog;
  /** How long to wait for a raised event to advance the run before giving up. */
  resumeTimeoutMs?: number;
  /** Poll interval while waiting for a run to advance. */
  pollIntervalMs?: number;
}

function initialRun(workflow: WorkflowDefinition, options: WorkflowStartOptions): WorkflowRun {
  return {
    id: randomUUID(),
    workflowId: workflow.id,
    status: 'running',
    currentNodeId: workflow.start,
    state: { ...(workflow.state ?? {}), ...(options.initialState ?? {}) },
    runPersonaId: options.personaId,
    runPersonaPolicy: options.personaPolicy ? structuredClone(options.personaPolicy) : undefined
  };
}

export class DaprWorkflowRunner implements WorkflowRunner {
  private readonly client: DaprWorkflowClientLike;
  private readonly runStore: RunStore;
  private readonly audit: AuditLog;
  private readonly resumeTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly workflow: WorkflowDefinition,
    options: DaprWorkflowRunnerOptions
  ) {
    this.client = options.client;
    this.runStore = options.runStore;
    this.audit = options.audit;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
  }

  async start(options: WorkflowStartOptions = {}): Promise<WorkflowRun> {
    const run = initialRun(this.workflow, options);
    this.audit.record({
      actor: { type: 'system', id: 'workflow-engine' },
      action: 'workflow.start',
      workflowRunId: run.id,
      detail: { workflowId: this.workflow.id }
    });
    const instanceId = await this.client.scheduleNewWorkflow(this.workflow.id, run, run.id);
    if (this.client.waitForWorkflowStart) {
      await this.client.waitForWorkflowStart(instanceId, false, 10);
    }
    // Return once the orchestrator's first state save is visible.
    return this.waitForSnapshot(run.id, () => true);
  }

  async resume(runId: string, response: HumanStepResponse): Promise<WorkflowRun> {
    const run = await this.runStore.load(runId);
    if (!run || run.status !== 'waitingForHuman' || !run.pending) {
      throw new Error(`Run '${runId}' is not waiting for human input`);
    }
    const node = this.workflow.nodes.find((n) => n.id === run.pending?.nodeId);
    if (!node) throw new Error(`Pending node '${run.pending.nodeId}' not found in workflow`);

    // ADR-0010: the runner, not the caller, is the authorization authority.
    authorizeHumanStep(run, (node as { role: string }).role, response.principal, this.audit, node.id);

    await this.client.raiseEvent(runId, HUMAN_TASK_EVENT, response);

    const waitedNode = run.pending.nodeId;
    return this.waitForSnapshot(
      runId,
      (snapshot) => snapshot.status !== 'waitingForHuman' || snapshot.pending?.nodeId !== waitedNode
    );
  }

  async query(runId: string): Promise<WorkflowRun | undefined> {
    return this.runStore.load(runId);
  }

  /** Poll the run store until the predicate holds or the timeout elapses. */
  private async waitForSnapshot(
    runId: string,
    predicate: (snapshot: WorkflowRun) => boolean
  ): Promise<WorkflowRun> {
    const deadline = Date.now() + this.resumeTimeoutMs;
    let snapshot = await this.runStore.load(runId);
    while (snapshot && !predicate(snapshot)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for run '${runId}' to advance`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      snapshot = await this.runStore.load(runId);
    }
    if (!snapshot) throw new Error(`Run '${runId}' not found`);
    return snapshot;
  }
}
