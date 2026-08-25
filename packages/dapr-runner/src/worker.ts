/**
 * Dapr worker registration (Phase 4.3.2). Registers the declarative workflows
 * and their activities on a {@link WorkflowRuntime} so a hosted Dapr sidecar
 * can orchestrate them. Activities are the only place side effects happen;
 * the orchestrators stay deterministic for durable execution.
 */
import { WorkflowRuntime, type TWorkflow } from '@dapr/dapr';
import type { WorkflowDefinition } from '@flowforge/core';
import { createActivities, type WorkflowDependencies } from './activities.js';
import { createWorkflowGenerator, type WorkflowContextLike } from './orchestrator.js';

/** The Dapr activity signature (not exported at the package top level). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DaprActivity = (context: any, input: any) => any;

/**
 * Register all workflows and activities on a Dapr {@link WorkflowRuntime}.
 * Call after `new WorkflowRuntime(...)` and before `runtime.start()`.
 */
export function registerDaprWorkflows(
  runtime: WorkflowRuntime,
  workflows: WorkflowDefinition[],
  deps: WorkflowDependencies
): { workflows: number; activities: number } {
  const activities = createActivities(deps);
  for (const [name, fn] of Object.entries(activities)) {
    runtime.registerActivityWithName(name, fn as unknown as DaprActivity);
  }
  for (const workflow of workflows) {
    const generator = createWorkflowGenerator(workflow);
    runtime.registerWorkflowWithName(workflow.id, generator as unknown as TWorkflow);
  }
  return { workflows: workflows.length, activities: Object.keys(activities).length };
}

export { createWorkflowGenerator, type WorkflowContextLike };
