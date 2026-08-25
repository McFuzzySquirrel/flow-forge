import type { WorkflowDefinition, WorkflowNode } from '@flowforge/core';
import type { HumanResponse } from '../../../src/ipc.js';
import { evaluateCondition } from './conditions.js';

export interface DryRunStep {
  nodeId: string;
  type: WorkflowNode['type'];
  detail?: string;
}

export type DryRunStatus = 'idle' | 'running' | 'waitingForHuman' | 'completed' | 'failed';

export interface DryRunState {
  status: DryRunStatus;
  currentNodeId: string | null;
  state: Record<string, unknown>;
  steps: DryRunStep[];
  pending?: { nodeId: string; kind: 'input' | 'approval'; role: string; prompt?: string; subject?: unknown };
  error?: string;
}

const MAX_STEPS = 1000;

/** Start a dry run at the workflow's start node. */
export function createDryRun(workflow: WorkflowDefinition): DryRunState {
  return {
    status: 'running',
    currentNodeId: workflow.start,
    state: { ...(workflow.state ?? {}) },
    steps: []
  };
}

/**
 * Interpret the workflow in the renderer until it pauses for a human step or
 * reaches a terminal state. Agent nodes use a fixed mock result; branch nodes
 * evaluate conditions against the synthetic state.
 */
export function advanceDryRun(state: DryRunState, workflow: WorkflowDefinition): DryRunState {
  let current: DryRunState = { ...state, status: 'running', pending: undefined, error: undefined };
  let guard = 0;
  while (current.status === 'running' && current.currentNodeId) {
    guard += 1;
    if (guard > MAX_STEPS) {
      return { ...current, status: 'failed', error: 'Dry run exceeded the maximum step count (possible loop)' };
    }
    const node = workflow.nodes.find((candidate) => candidate.id === current.currentNodeId);
    if (!node) {
      return { ...current, status: 'failed', error: `Unknown node '${current.currentNodeId}'` };
    }
    current = stepNode(current, node);
  }
  return current;
}

function stepNode(state: DryRunState, node: WorkflowNode): DryRunState {
  const steps = [...state.steps];
  switch (node.type) {
    case 'agent': {
      steps.push({ nodeId: node.id, type: node.type, detail: `agent "${node.agent}" · attempt 1` });
      const nextState = { ...state.state };
      if (node.output) {
        nextState[node.output] = 'mock agent result';
        nextState.score = 80;
      }
      return { ...state, state: nextState, steps, currentNodeId: node.next ?? null };
    }
    case 'humanInput':
      steps.push({ nodeId: node.id, type: node.type });
      return {
        ...state,
        status: 'waitingForHuman',
        steps,
        pending: { nodeId: node.id, kind: 'input', role: node.role, prompt: node.prompt }
      };
    case 'humanApproval': {
      steps.push({ nodeId: node.id, type: node.type });
      const subject = node.subject ? state.state[node.subject] : undefined;
      return {
        ...state,
        status: 'waitingForHuman',
        steps,
        pending: { nodeId: node.id, kind: 'approval', role: node.role, subject }
      };
    }
    case 'branch': {
      const matched = node.conditions.find((condition) => {
        try {
          return evaluateCondition(condition.when, state.state);
        } catch {
          return false;
        }
      });
      if (!matched) {
        return { ...state, status: 'failed', error: `No branch condition matched at node '${node.id}'` };
      }
      steps.push({ nodeId: node.id, type: node.type, detail: `→ ${matched.when}` });
      return { ...state, steps, currentNodeId: matched.next };
    }
    case 'parallel':
      steps.push({ nodeId: node.id, type: node.type, detail: 'parallel not simulated — continuing via next' });
      return { ...state, steps, currentNodeId: node.next ?? null };
    case 'end':
      steps.push({ nodeId: node.id, type: node.type });
      return { ...state, status: 'completed', currentNodeId: null, steps };
  }
}

/** Apply a human response to a paused dry run and keep interpreting. */
export function respondDryRun(state: DryRunState, workflow: WorkflowDefinition, response: HumanResponse): DryRunState {
  if (state.status !== 'waitingForHuman' || !state.pending) return state;
  const node = workflow.nodes.find((candidate) => candidate.id === state.pending?.nodeId);
  if (!node) return { ...state, status: 'failed', error: `Pending node '${state.pending.nodeId}' not found` };

  let nextState = state.state;
  let nextNodeId: string | undefined;
  if (node.type === 'humanInput') {
    nextState = { ...nextState, [node.output]: response.value };
    nextNodeId = node.next;
  } else if (node.type === 'humanApproval') {
    nextNodeId = response.approved === true ? (node.onApprove ?? node.next) : node.onReject;
    if (!nextNodeId) {
      return {
        ...state,
        status: 'failed',
        error: `Approval node '${node.id}' has no target for ${response.approved === true ? 'approval' : 'rejection'}`
      };
    }
  } else {
    return { ...state, status: 'failed', error: `Node '${node.id}' is not a human step` };
  }

  return advanceDryRun({ ...state, state: nextState, currentNodeId: nextNodeId ?? null, pending: undefined }, workflow);
}
