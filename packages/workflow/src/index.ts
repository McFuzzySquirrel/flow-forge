import { randomUUID } from 'node:crypto';
import type {
  AgentNode,
  BranchNode,
  HumanApprovalNode,
  HumanInputNode,
  WorkflowDefinition,
  WorkflowNode
} from '@flowforge/core';
import { AuditLog } from '@flowforge/audit';
import type { AgentRuntime } from '@flowforge/agents';

export type RunStatus = 'running' | 'waitingForHuman' | 'completed' | 'failed';

export interface PendingHumanTask {
  nodeId: string;
  kind: 'input' | 'approval';
  role: string;
  prompt?: string;
  subject?: unknown;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  currentNodeId?: string;
  state: Record<string, unknown>;
  pending?: PendingHumanTask;
  error?: string;
}

/** Pluggable persistence for workflow state (transactional data, not memory). */
export interface StateStore {
  save(run: WorkflowRun): void;
  load(runId: string): WorkflowRun | undefined;
}

export class InMemoryStateStore implements StateStore {
  private runs = new Map<string, WorkflowRun>();
  save(run: WorkflowRun): void {
    this.runs.set(run.id, structuredClone(run));
  }
  load(runId: string): WorkflowRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

/** Evaluates simple branch conditions like "score >= 50" or "default" over state. */
const OPERATORS = ['>=', '<=', '==', '!=', '>', '<'] as const;

export function evaluateCondition(expression: string, state: Record<string, unknown>): boolean {
  if (expression === 'default') return true;
  const trimmed = expression.trim();
  const operator = OPERATORS.find((op) => trimmed.includes(op));
  if (!operator) throw new Error(`Unsupported condition expression: '${expression}'`);
  const index = trimmed.indexOf(operator);
  const path = trimmed.slice(0, index).trim();
  const rawValue = trimmed.slice(index + operator.length).trim();
  if (!/^[a-zA-Z_][\w.]*$/.test(path) || rawValue.length === 0) {
    throw new Error(`Unsupported condition expression: '${expression}'`);
  }
  let left: unknown = state;
  for (const key of path.split('.')) {
    left = (left as Record<string, unknown> | undefined)?.[key];
  }
  let right: unknown;
  if (rawValue === 'true') right = true;
  else if (rawValue === 'false') right = false;
  else if (rawValue === 'null') right = null;
  else if (!Number.isNaN(Number(rawValue))) right = Number(rawValue);
  else right = rawValue.replace(/^['"]|['"]$/g, '');
  switch (operator) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    default:
      throw new Error(`Unsupported operator: '${operator}'`);
  }
}

/**
 * Embedded in-process workflow runner. Interprets the declarative workflow
 * spec: agent steps (with retries), human-input and human-approval steps
 * (pause/resume), branching and end nodes. The workflow definition is
 * portable; this engine is one of potentially several runners (a Dapr
 * Workflows runner can implement the same behaviour server-side).
 */
export class WorkflowEngine {
  constructor(
    private readonly agents: AgentRuntime,
    private readonly audit: AuditLog,
    private readonly store: StateStore = new InMemoryStateStore()
  ) {}

  start(workflow: WorkflowDefinition, initialState: Record<string, unknown> = {}): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      status: 'running',
      currentNodeId: workflow.start,
      state: { ...(workflow.state ?? {}), ...initialState }
    };
    this.audit.record({
      actor: { type: 'system', id: 'workflow-engine' },
      action: 'workflow.start',
      workflowRunId: run.id,
      detail: { workflowId: workflow.id }
    });
    return this.advance(workflow, run);
  }

  /** Resume a paused run with human input or an approval decision. */
  async resume(
    workflow: WorkflowDefinition,
    runId: string,
    humanResponse: { userId: string; value?: unknown; approved?: boolean; reason?: string }
  ): Promise<WorkflowRun> {
    const run = this.store.load(runId);
    if (!run) throw new Error(`Unknown run '${runId}'`);
    if (run.status !== 'waitingForHuman' || !run.pending || !run.currentNodeId) {
      throw new Error(`Run '${runId}' is not waiting for human input`);
    }
    const node = this.node(workflow, run.currentNodeId);

    if (node.type === 'humanInput') {
      run.state[node.output] = humanResponse.value;
      this.audit.record({
        actor: { type: 'human', id: humanResponse.userId },
        action: 'human.input',
        workflowRunId: run.id,
        nodeId: node.id,
        detail: { output: node.output }
      });
      run.currentNodeId = node.next;
    } else if (node.type === 'humanApproval') {
      const approved = humanResponse.approved === true;
      this.audit.record({
        actor: { type: 'human', id: humanResponse.userId },
        action: approved ? 'human.approval' : 'human.rejection',
        workflowRunId: run.id,
        nodeId: node.id,
        detail: { reason: humanResponse.reason ?? '', subject: node.subject ?? '' }
      });
      run.currentNodeId = approved ? (node.onApprove ?? node.next) : node.onReject;
      if (!run.currentNodeId) {
        throw new Error(`Approval node '${node.id}' has no target for decision`);
      }
    } else {
      throw new Error(`Node '${node.id}' is not a human step`);
    }

    run.pending = undefined;
    run.status = 'running';
    return this.advance(workflow, run);
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.store.load(runId);
  }

  private node(workflow: WorkflowDefinition, id: string): WorkflowNode {
    const node = workflow.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Unknown node '${id}' in workflow '${workflow.id}'`);
    return node;
  }

  private async advance(workflow: WorkflowDefinition, run: WorkflowRun): Promise<WorkflowRun> {
    try {
      while (run.status === 'running' && run.currentNodeId) {
        const node = this.node(workflow, run.currentNodeId);
        switch (node.type) {
          case 'agent':
            await this.runAgentNode(node, run);
            run.currentNodeId = node.next;
            break;
          case 'humanInput':
            run.status = 'waitingForHuman';
            run.pending = {
              nodeId: node.id,
              kind: 'input',
              role: (node as HumanInputNode).role,
              prompt: (node as HumanInputNode).prompt
            };
            break;
          case 'humanApproval': {
            const approval = node as HumanApprovalNode;
            run.status = 'waitingForHuman';
            run.pending = {
              nodeId: node.id,
              kind: 'approval',
              role: approval.role,
              subject: approval.subject ? run.state[approval.subject] : undefined
            };
            break;
          }
          case 'branch': {
            const branch = node as BranchNode;
            const matched = branch.conditions.find((c) => evaluateCondition(c.when, run.state));
            if (!matched) throw new Error(`No branch condition matched at node '${node.id}'`);
            run.currentNodeId = matched.next;
            break;
          }
          case 'parallel':
            throw new Error('Parallel nodes are not yet supported by the embedded runner');
          case 'end':
            run.status = 'completed';
            run.currentNodeId = undefined;
            this.audit.record({
              actor: { type: 'system', id: 'workflow-engine' },
              action: 'workflow.complete',
              workflowRunId: run.id
            });
            break;
        }
      }
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      this.audit.record({
        actor: { type: 'system', id: 'workflow-engine' },
        action: 'workflow.fail',
        workflowRunId: run.id,
        nodeId: run.currentNodeId,
        detail: { error: run.error }
      });
    }
    this.store.save(run);
    return run;
  }

  private async runAgentNode(node: AgentNode, run: WorkflowRun): Promise<void> {
    const maxAttempts = node.retry?.maxAttempts ?? 1;
    const inputs: Record<string, unknown> = {};
    for (const name of node.inputs ?? []) inputs[name] = run.state[name];

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.agents.step({
          agentId: node.agent,
          action: node.action,
          inputs,
          personaId: node.persona,
          workflowRunId: run.id,
          nodeId: node.id
        });
        if (node.output) run.state[node.output] = result.output;
        return;
      } catch (error) {
        lastError = error;
        this.audit.record({
          actor: { type: 'system', id: 'workflow-engine' },
          action: 'agent.step.retry',
          workflowRunId: run.id,
          nodeId: node.id,
          detail: { attempt, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Agent node '${node.id}' failed after ${maxAttempts} attempts`);
  }
}
