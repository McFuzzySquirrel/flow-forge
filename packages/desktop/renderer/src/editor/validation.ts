import type { WorkflowDefinition, WorkflowNode } from '@flowforge/core';

/** All node ids this node can transition to (mirrors the kernel's graph rules). */
export function nodeTargets(node: WorkflowNode): string[] {
  const targets: string[] = [];
  if (node.next) targets.push(node.next);
  if (node.type === 'humanApproval') {
    if (node.onApprove) targets.push(node.onApprove);
    if (node.onReject) targets.push(node.onReject);
  }
  if (node.type === 'branch') targets.push(...node.conditions.map((condition) => condition.next));
  if (node.type === 'parallel') targets.push(...node.branches);
  return targets;
}

/**
 * Continuous graph validation for the editor, mirroring the kernel's
 * validateGraph: start exists, all targets exist, branches have a default
 * condition, and every node is reachable from start via BFS.
 */
export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(workflow.start)) {
    errors.push(`Start node '${workflow.start}' not found`);
  }

  for (const node of workflow.nodes) {
    for (const target of nodeTargets(node)) {
      if (!nodesById.has(target)) {
        errors.push(`Node '${node.id}' points to missing node '${target}'`);
      }
    }
    if (node.type === 'branch' && !node.conditions.some((condition) => condition.when === 'default')) {
      errors.push(`Branch node '${node.id}' is missing a default condition`);
    }
  }

  if (!nodesById.has(workflow.start)) return errors;

  const visited = new Set<string>();
  const queue = [workflow.start];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) continue;
    for (const target of nodeTargets(node)) {
      if (!visited.has(target)) queue.push(target);
    }
  }

  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) errors.push(`Node '${node.id}' not reachable from start`);
  }
  return errors;
}
