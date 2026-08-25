import type {
  AgentNode,
  BranchNode,
  EndNode,
  HumanApprovalNode,
  HumanInputNode,
  ParallelNode,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType
} from '@flowforge/core';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { nodeTargets } from './validation.js';

export type WorkflowNodeData = {
  node: WorkflowNode;
  current?: boolean;
  pending?: boolean;
  visited?: boolean;
};

export type FlowNode = Node<WorkflowNodeData, 'workflow'>;
export type FlowEdge = Edge;

const EDGE_STYLE: Edge['style'] = { stroke: '#64748b', strokeWidth: 1.5 };
const DASHED_STYLE: Edge['style'] = { ...EDGE_STYLE, strokeDasharray: '6 4' };
const LABEL_STYLE = {
  fontSize: 10,
  fill: '#8b93a7',
  fontFamily: 'system-ui, sans-serif',
  lineHeight: 1.2
};

/** Node ordering for layout: edge-driven BFS from start (unreachable nodes last). */
export function bfsOrder(workflow: WorkflowDefinition): string[] {
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const order: string[] = [];
  const visited = new Set<string>();
  const queue = [workflow.start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const node = nodesById.get(id);
    if (!node) continue;
    for (const target of nodeTargets(node)) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) order.push(node.id);
  }
  return order;
}

/** Fixed grid slot for a BFS-ordered node index. */
export function gridPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * 220, y: Math.floor(index / 3) * 140 };
}

export function nodesFromWorkflow(workflow: WorkflowDefinition, prev: FlowNode[]): FlowNode[] {
  const order = bfsOrder(workflow);
  const prevById = new Map(prev.map((node) => [node.id, node]));
  return workflow.nodes.map((node, workflowIndex) => {
    const existing = prevById.get(node.id);
    const orderIndex = order.indexOf(node.id);
    const index = orderIndex === -1 ? workflowIndex : orderIndex;
    return {
      id: node.id,
      type: 'workflow',
      position: existing?.position ?? gridPosition(index),
      data: {
        node,
        current: existing?.data.current,
        pending: existing?.data.pending,
        visited: existing?.data.visited
      }
    };
  });
}

export function edgesFromWorkflow(workflow: WorkflowDefinition): FlowEdge[] {
  const edges: FlowEdge[] = [];
  const push = (
    id: string,
    source: string,
    target: string,
    sourceHandle: string,
    style: Edge['style'],
    label?: string
  ) => {
    edges.push({
      id,
      source,
      target,
      sourceHandle,
      type: 'smoothstep',
      style,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { traversed: false },
      ...(label !== undefined ? { label, labelStyle: LABEL_STYLE, labelShowBg: true } : {})
    });
  };

  for (const node of workflow.nodes) {
    if (node.type === 'agent' || node.type === 'humanInput') {
      if (node.next) push(`next:${node.id}`, node.id, node.next, 'out', EDGE_STYLE);
    } else if (node.type === 'humanApproval') {
      const approveTarget = node.onApprove ?? node.next;
      if (approveTarget) push(`approve:${node.id}`, node.id, approveTarget, 'approve', DASHED_STYLE, 'approve');
      if (node.onReject) push(`reject:${node.id}`, node.id, node.onReject, 'reject', DASHED_STYLE, 'reject');
    } else if (node.type === 'branch') {
      node.conditions.forEach((condition, index) => {
        if (condition.next) push(`cond:${node.id}:${index}`, node.id, condition.next, 'out', DASHED_STYLE, condition.when);
      });
    } else if (node.type === 'parallel') {
      node.branches.forEach((target, index) => {
        if (target) push(`branch:${node.id}:${index}`, node.id, target, 'out', DASHED_STYLE, `branch ${index + 1}`);
      });
    }
  }
  return edges;
}

export type EdgeRef =
  | { kind: 'next' | 'approve' | 'reject'; source: string }
  | { kind: 'cond' | 'branch'; source: string; index: number };

export function parseEdgeRef(edge: Edge): EdgeRef {
  const parts = edge.id.split(':');
  const kind = parts[0];
  const source = parts[1] ?? '';
  if (kind === 'cond' || kind === 'branch') {
    return { kind, source, index: Number(parts[2] ?? 0) };
  }
  return { kind: kind as 'next' | 'approve' | 'reject', source };
}

export function patchNode(workflow: WorkflowDefinition, id: string, patch: Partial<WorkflowNode>): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === id ? ({ ...node, ...patch } as WorkflowNode) : node
    )
  };
}

export function removeNodesFromWorkflow(workflow: WorkflowDefinition, ids: Set<string>): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !ids.has(node.id)).map((node) => stripDeletedRefs(node, ids))
  };
}

/** Drop references to deleted nodes so the graph stays consistent. */
export function stripDeletedRefs(node: WorkflowNode, deleted: Set<string>): WorkflowNode {
  if (node.type === 'humanApproval') {
    return {
      ...node,
      next: node.next && deleted.has(node.next) ? undefined : node.next,
      onApprove: node.onApprove && deleted.has(node.onApprove) ? undefined : node.onApprove,
      onReject: node.onReject && deleted.has(node.onReject) ? undefined : node.onReject
    };
  }
  if (node.type === 'branch') {
    return {
      ...node,
      next: node.next && deleted.has(node.next) ? undefined : node.next,
      conditions: node.conditions.filter((condition) => !deleted.has(condition.next))
    };
  }
  if (node.type === 'parallel') {
    return {
      ...node,
      next: node.next && deleted.has(node.next) ? undefined : node.next,
      branches: node.branches.filter((target) => !deleted.has(target))
    };
  }
  if (node.type === 'agent' || node.type === 'humanInput') {
    return { ...node, next: node.next && deleted.has(node.next) ? undefined : node.next };
  }
  return node;
}

export function removeEdgesFromWorkflow(workflow: WorkflowDefinition, edges: Edge[]): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const relevant = edges.filter((edge) => edge.source === node.id);
      if (relevant.length === 0) return node;
      return applyEdgeRemovals(node, relevant);
    })
  };
}

function applyEdgeRemovals(node: WorkflowNode, edges: Edge[]): WorkflowNode {
  const refs = edges.map(parseEdgeRef);
  const removedKinds = new Set<string>();
  const removedIndexes = new Map<string, Set<number>>();
  for (const ref of refs) {
    if (ref.kind === 'cond' || ref.kind === 'branch') {
      const indexes = removedIndexes.get(ref.kind) ?? new Set<number>();
      indexes.add(ref.index);
      removedIndexes.set(ref.kind, indexes);
    } else {
      removedKinds.add(ref.kind);
    }
  }

  if (node.type === 'humanApproval') {
    return {
      ...node,
      next: removedKinds.has('next') ? undefined : node.next,
      onApprove: removedKinds.has('approve') ? undefined : node.onApprove,
      onReject: removedKinds.has('reject') ? undefined : node.onReject
    };
  }
  if (node.type === 'branch') {
    return {
      ...node,
      next: removedKinds.has('next') ? undefined : node.next,
      conditions: node.conditions.filter((_, index) => !removedIndexes.get('cond')?.has(index))
    };
  }
  if (node.type === 'parallel') {
    return {
      ...node,
      next: removedKinds.has('next') ? undefined : node.next,
      branches: node.branches.filter((_, index) => !removedIndexes.get('branch')?.has(index))
    };
  }
  if (node.type === 'agent' || node.type === 'humanInput') {
    return { ...node, next: removedKinds.has('next') ? undefined : node.next };
  }
  return node;
}

/** Rename a node id and retarget every reference to it. */
export function retargetWorkflow(workflow: WorkflowDefinition, oldId: string, newId: string): WorkflowDefinition {
  const remap = (id: string): string => (id === oldId ? newId : id);
  return {
    ...workflow,
    start: remap(workflow.start),
    nodes: workflow.nodes.map((node) => {
      const base = node.next ? { ...node, next: remap(node.next) } : node;
      if (base.type === 'humanApproval') {
        return {
          ...base,
          onApprove: base.onApprove ? remap(base.onApprove) : undefined,
          onReject: base.onReject ? remap(base.onReject) : undefined
        };
      }
      if (base.type === 'branch') {
        return { ...base, conditions: base.conditions.map((condition) => ({ ...condition, next: remap(condition.next) })) };
      }
      if (base.type === 'parallel') {
        return { ...base, branches: base.branches.map(remap) };
      }
      return base;
    })
  };
}

export function createNode(type: WorkflowNodeType, id: string): WorkflowNode {
  switch (type) {
    case 'agent':
      return { id, type, agent: '', action: '', next: undefined } as AgentNode;
    case 'humanInput':
      return { id, type, role: '', prompt: '', output: '', next: undefined } as HumanInputNode;
    case 'humanApproval':
      return { id, type, role: '', subject: '' } as HumanApprovalNode;
    case 'branch':
      return { id, type, conditions: [{ when: 'default', next: '' }] } as BranchNode;
    case 'parallel':
      return { id, type, branches: [] } as ParallelNode;
    case 'end':
      return { id, type } as EndNode;
  }
}

/** Fresh unique node id for the given type. */
export function uniqueNodeId(type: WorkflowNodeType, existing: string[]): string {
  const seen = new Set(existing);
  let index = 1;
  let candidate = `${type}-${index}`;
  while (seen.has(candidate)) {
    index += 1;
    candidate = `${type}-${index}`;
  }
  return candidate;
}
