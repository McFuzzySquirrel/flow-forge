/**
 * Dapr workflow orchestrator (Phase 4.3.2).
 *
 * Translates a declarative workflow.schema.json into a Dapr Workflow generator:
 * agent nodes become activities, human nodes become `waitForExternalEvent`
 * waits (the hosted-scale version of our `waitingForHuman` status), branch
 * nodes evaluate deterministically inside the orchestrator. All state mutations
 * and side effects happen in activities or are derived from the run snapshot,
 * so the orchestrator is deterministic and replays safely.
 *
 * The generator is written against a minimal context surface
 * ({@link WorkflowContextLike}) so the SAME implementation runs under Dapr's
 * real {@link WorkflowRuntime} (casting to TWorkflow at registration) and under
 * the in-process executor used by the conformance suite.
 */
import type { AgentNode, BranchNode, HumanApprovalNode, HumanInputNode, WorkflowDefinition } from '@flowforge/core';
import { evaluateCondition, type WorkflowRun } from '@flowforge/workflow';
import { Activities, HUMAN_TASK_EVENT } from './types.js';

/** Minimal context surface the orchestrator depends on (real Dapr satisfies it). */
export interface WorkflowContextLike {
  callActivity(name: string, input?: unknown): unknown;
  waitForExternalEvent(name: string): unknown;
  setCustomStatus(status: string): void;
}

/**
 * Build the generator function for one workflow definition.
 *
 * @param workflow the declarative workflow to interpret
 */
export function createWorkflowGenerator(
  workflow: WorkflowDefinition
): (ctx: WorkflowContextLike, input: WorkflowRun) => Generator<unknown, WorkflowRun, unknown> {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node] as const));

  return function* workflowGenerator(ctx: WorkflowContextLike, input: WorkflowRun): Generator<unknown, WorkflowRun, unknown> {
    let current: WorkflowRun = structuredClone(input);
    yield ctx.callActivity(Activities.save, { run: current });

    while (true) {
      const node = nodeById.get(current.currentNodeId ?? '');
      if (!node) throw new Error(`Workflow '${workflow.id}': unknown node '${current.currentNodeId}'`);

      switch (node.type) {
        case 'agent': {
          const agentNode = node as AgentNode;
          const inputs: Record<string, unknown> = {};
          for (const name of agentNode.inputs ?? []) inputs[name] = current.state?.[name];
          const { output } = (yield ctx.callActivity(Activities.agentStep, {
            nodeId: agentNode.id,
            agentId: agentNode.agent,
            action: agentNode.action,
            inputs,
            personaId: agentNode.persona ?? current.runPersonaId,
            workflowRunId: current.id
          })) as { output: unknown };
          if (agentNode.output) {
            current = {
              ...current,
              state: { ...(current.state ?? {}), [agentNode.output]: output }
            };
          }
          if (agentNode.memoryWrite) {
            for (const entry of agentNode.memoryWrite) {
              const text = entry.text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(current.state?.[key] ?? ''));
              yield ctx.callActivity(Activities.memoryWrite, {
                agentId: agentNode.agent,
                namespace: entry.namespace,
                text
              });
            }
          }
          current = { ...current, currentNodeId: agentNode.next };
          break;
        }

        case 'humanInput': {
          const node2 = node as HumanInputNode;
          current = {
            ...current,
            status: 'waitingForHuman',
            currentNodeId: node2.id,
            pending: { nodeId: node2.id, kind: 'input', role: node2.role, prompt: node2.prompt }
          };
          yield ctx.callActivity(Activities.save, { run: current });
          ctx.setCustomStatus(`waitingForHuman:${node2.id}`);
          const response = (yield ctx.waitForExternalEvent(HUMAN_TASK_EVENT)) as {
            principal: { id: string };
            value?: unknown;
          };
          const resolved = (yield ctx.callActivity(Activities.humanStep, {
            run: current,
            node: node2,
            response
          })) as WorkflowRun;
          current = resolved;
          break;
        }

        case 'humanApproval': {
          const node2 = node as HumanApprovalNode;
          current = {
            ...current,
            status: 'waitingForHuman',
            currentNodeId: node2.id,
            pending: {
              nodeId: node2.id,
              kind: 'approval',
              role: node2.role,
              subject: node2.subject ? current.state?.[node2.subject] : undefined
            }
          };
          yield ctx.callActivity(Activities.save, { run: current });
          ctx.setCustomStatus(`waitingForHuman:${node2.id}`);
          const response = (yield ctx.waitForExternalEvent(HUMAN_TASK_EVENT)) as {
            principal: { id: string };
            approved?: boolean;
            reason?: string;
          };
          const resolved = (yield ctx.callActivity(Activities.humanStep, {
            run: current,
            node: node2,
            response
          })) as WorkflowRun;
          current = resolved;
          break;
        }

        case 'branch': {
          const branch = node as BranchNode;
          const matched = branch.conditions.find((condition) =>
            evaluateCondition(condition.when, current.state ?? {}, current.runPersonaPolicy)
          );
          if (!matched) throw new Error(`No branch condition matched at node '${branch.id}'`);
          current = { ...current, currentNodeId: matched.next };
          break;
        }

        case 'parallel':
          throw new Error('Parallel nodes are not yet supported by the Dapr runner');

        case 'end':
          current = { ...current, status: 'completed', currentNodeId: undefined, pending: undefined };
          yield ctx.callActivity(Activities.save, { run: current });
          ctx.setCustomStatus('completed');
          return current;
      }

      yield ctx.callActivity(Activities.save, { run: current });
    }
  };
}
