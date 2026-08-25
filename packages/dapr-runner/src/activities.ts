/**
 * Dapr workflow activities (Phase 4.3.2). All side effects — LLM calls, memory
 * writes, state persistence, human-step mutation — live in activities, never in
 * the orchestrator, so the orchestrator stays deterministic and replays cleanly
 * after crashes (durable execution).
 */
import type { AuditLog } from '@flowforge/audit';
import { principalActor, type WorkflowNode } from '@flowforge/core';
import { applyHumanResponse, type WorkflowRun } from '@flowforge/workflow';
import type { AgentRuntime } from '@flowforge/agents';
import { Activities, HUMAN_TASK_EVENT, type RunStore } from './types.js';

export interface WorkflowDependencies {
  runStore: RunStore;
  agents: AgentRuntime;
  audit: AuditLog;
}

export interface AgentStepInput {
  nodeId: string;
  agentId: string;
  action: string;
  /** Resolved input values (state → values), resolved by the orchestrator. */
  inputs: Record<string, unknown>;
  personaId?: string;
  workflowRunId: string;
}

export interface HumanStepInput {
  run: WorkflowRun;
  node: WorkflowNode;
  response: { principal: Parameters<typeof principalActor>[0]; value?: unknown; approved?: boolean; reason?: string };
}

/**
 * Build the activity registry the worker registers. Activities are closures
 * over the shared dependencies so the same code runs in-process (tests) and
 * hosted on a Dapr worker (production).
 */
export function createActivities(deps: WorkflowDependencies) {
  return {
    [Activities.save]: async (_ctx: unknown, input: { run: WorkflowRun }) => {
      await deps.runStore.save(input.run);
      return { ok: true };
    },

    [Activities.agentStep]: async (_ctx: unknown, input: AgentStepInput): Promise<{ output: unknown }> => {
      const result = await deps.agents.step({
        agentId: input.agentId,
        action: input.action,
        inputs: input.inputs,
        personaId: input.personaId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId
      });
      return { output: result.output };
    },

    [Activities.memoryWrite]: async (
      _ctx: unknown,
      input: { agentId: string; namespace?: string; text: string }
    ) => {
      await deps.agents.writeMemory(input.agentId, input.text, input.namespace);
      return { ok: true };
    },

    [Activities.humanStep]: async (_ctx: unknown, input: HumanStepInput): Promise<WorkflowRun> => {
      const outcome = applyHumanResponse(input.run, input.node as Parameters<typeof applyHumanResponse>[1], input.response);
      deps.audit.record({
        actor: principalActor(input.response.principal),
        action: outcome.audit.action,
        workflowRunId: input.run.id,
        nodeId: input.node.id,
        detail: outcome.audit.detail
      });
      return outcome.run;
    }
  };
}

export type ActivityRegistry = ReturnType<typeof createActivities>;

export { HUMAN_TASK_EVENT };
