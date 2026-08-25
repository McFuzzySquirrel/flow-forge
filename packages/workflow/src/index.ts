import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentNode,
  BranchNode,
  HumanApprovalNode,
  HumanInputNode,
  Principal,
  WorkflowDefinition,
  WorkflowNode
} from '@flowforge/core';
import { principalActor } from '@flowforge/core';
import { AuditLog } from '@flowforge/audit';
import type { AgentRuntime } from '@flowforge/agents';

export type RunStatus = 'running' | 'waitingForHuman' | 'completed' | 'failed';

/** Thrown when a principal is not allowed to act on the pending human step. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

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
  /** Per-run participant bindings: role → principal id of whoever first acted in that role. */
  participants?: Record<string, string>;
  runPersonaId?: string;
  runPersonaPolicy?: Record<string, unknown>;
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

/** File-backed state store: persists each run as a JSON file in a directory. */
export class FileStateStore implements StateStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(run: WorkflowRun): void {
    writeFileSync(join(this.dir, `${run.id}.json`), JSON.stringify(run), 'utf8');
  }

  load(runId: string): WorkflowRun | undefined {
    const path = join(this.dir, `${runId}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowRun;
  }
}

/** Evaluates simple branch conditions like "score >= 50" or "default" over state. */
const OPERATORS = ['>=', '<=', '==', '!=', '>', '<'] as const;

export function evaluateCondition(
  expression: string,
  state: Record<string, unknown>,
  personaPolicy?: Record<string, unknown>
): boolean {
  if (expression === 'default') return true;
  const trimmed = expression.trim();
  const operator = OPERATORS.find((op) => trimmed.includes(op));
  if (!operator) throw new Error(`Unsupported condition expression: '${expression}'`);
  const index = trimmed.indexOf(operator);
  const path = trimmed.slice(0, index).trim();
  const rawValue = trimmed.slice(index + operator.length).trim();
  if (!/^[$a-zA-Z_][\w.]*$/.test(path) || rawValue.length === 0) {
   throw new Error(`Unsupported condition expression: '${expression}'`);
  }
  const personaRoot = personaPolicy ?? ((state['$persona'] ?? {}) as Record<string, unknown>);
  let left: unknown = path === '$persona' || path.startsWith('$persona.') ? personaRoot : state;
  for (const key of path.split('.')) {
   if (key === '$persona') continue;
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

export function validateGraph(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node] as const));
  if (!nodesById.has(workflow.start)) {
    errors.push(`Start node '${workflow.start}' not found`);
  }

  const targetsFor = (node: WorkflowNode): string[] => {
    const targets: string[] = [];
    if (node.next) targets.push(node.next);
    if (node.type === 'humanApproval') {
      if (node.onApprove) targets.push(node.onApprove);
      if (node.onReject) targets.push(node.onReject);
    }
    if (node.type === 'branch') targets.push(...node.conditions.map((condition) => condition.next));
    if (node.type === 'parallel') targets.push(...node.branches);
    return targets;
  };

  for (const node of workflow.nodes) {
    for (const target of targetsFor(node)) {
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
    for (const target of targetsFor(node)) {
      if (!visited.has(target)) queue.push(target);
    }
  }

  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) errors.push(`Node '${node.id}' not reachable from start`);
  }
  return errors;
}

export interface WorkflowStartOptions {
  personaId?: string;
  personaPolicy?: Record<string, unknown>;
  initialState?: Record<string, unknown>;
}

/**
 * A human response to a pending human-input / human-approval node. Mirrors the
 * embedded engine's resume payload so every runner shares the same contract.
 */
export interface HumanStepResponse {
  principal: Principal;
  value?: unknown;
  approved?: boolean;
  reason?: string;
}

/**
 * Transport-agnostic workflow runner contract (Phase 4.3). Both the embedded
 * in-process engine and the Dapr Workflows runner implement this interface, so
 * a conformance suite can prove one spec, two runners, same results. A runner
 * is bound to a single workflow definition.
 */
export interface WorkflowRunner {
  /** Start a new run of the runner's bound workflow. */
  start(options?: WorkflowStartOptions): Promise<WorkflowRun>;
  /**
   * Deliver a human response to a paused run (the "deliver-human-task"
   * operation). Authorization (role + per-run participant binding, ADR-0010)
   * is enforced by the runner before the response is applied.
   */
  resume(runId: string, response: HumanStepResponse): Promise<WorkflowRun>;
  /** Query the current state of a run. */
  query(runId: string): Promise<WorkflowRun | undefined>;
}

/**
 * Adapts the embedded {@link WorkflowEngine} to the {@link WorkflowRunner}
 * interface for a single workflow. The engine is the reference implementation;
 * the conformance suite drives it and the Dapr runner identically.
 */
export class EmbeddedWorkflowRunner implements WorkflowRunner {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly workflow: WorkflowDefinition
  ) {}

  start(options: WorkflowStartOptions = {}): Promise<WorkflowRun> {
    return this.engine.start(this.workflow, options);
  }

  resume(runId: string, response: HumanStepResponse): Promise<WorkflowRun> {
    return this.engine.resume(this.workflow, runId, response);
  }

  query(runId: string): Promise<WorkflowRun | undefined> {
    return Promise.resolve(this.engine.getRun(runId));
  }
}

/**
 * Shared role + per-run participant-binding check (ADR-0010). Denials are
 * audited and raise {@link AuthorizationError}; the run is left untouched.
 * Used by every runner so authorization is enforced identically everywhere.
 */
export function authorizeHumanStep(
  run: WorkflowRun,
  role: string,
  principal: Principal,
  audit: AuditLog,
  nodeId?: string
): void {
  const reason = unauthorizedReason(run, role, principal);
  if (reason) {
    audit.record({
      actor: principalActor(principal),
      action: 'workflow.authorization.denied',
      workflowRunId: run.id,
      nodeId: nodeId ?? run.currentNodeId,
      detail: { requiredRole: role, reason }
    });
    throw new AuthorizationError(`Not authorized to act on run '${run.id}': ${reason}`);
  }
}

/** Pure role/binding check: returns a human-readable reason when unauthorized. */
export function unauthorizedReason(
  run: WorkflowRun,
  role: string,
  principal: Principal
): string | undefined {
  if (!principal.roles.includes(role)) {
    return `principal does not hold role '${role}'`;
  }
  const boundTo = run.participants?.[role];
  if (boundTo && boundTo !== principal.id) {
    return `role '${role}' is bound to another participant for this run`;
  }
  return undefined;
}

/**
 * Apply a validated human response to a run snapshot, returning the updated run
 * and the audit event to record. Shared by every runner so human steps mutate
 * state identically regardless of the execution substrate.
 */
export function applyHumanResponse(
  run: WorkflowRun,
  node: HumanInputNode | HumanApprovalNode,
  response: HumanStepResponse
): { run: WorkflowRun; audit: { action: string; detail: Record<string, unknown> } } {
  const updated = structuredClone(run);
  updated.participants = { ...(updated.participants ?? {}), [node.role]: response.principal.id };
  let action: string;
  let detail: Record<string, unknown>;
  if (node.type === 'humanInput') {
    updated.state = { ...(updated.state ?? {}), [node.output]: response.value };
    action = 'human.input';
    detail = { output: node.output };
    updated.currentNodeId = node.next;
  } else {
    const approved = response.approved === true;
    action = approved ? 'human.approval' : 'human.rejection';
    detail = { reason: response.reason ?? '', subject: node.subject ?? '' };
    updated.currentNodeId = approved ? (node.onApprove ?? node.next) : node.onReject;
    if (!updated.currentNodeId) {
      throw new Error(`Approval node '${node.id}' has no target for decision`);
    }
  }
  updated.pending = undefined;
  updated.status = 'running';
  return { run: updated, audit: { action, detail } };
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

  start(
    workflow: WorkflowDefinition,
    options: WorkflowStartOptions = {}
  ): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      status: 'running',
      currentNodeId: workflow.start,
      state: { ...(workflow.state ?? {}), ...(options.initialState ?? {}) },
      runPersonaId: options.personaId,
      runPersonaPolicy: options.personaPolicy ? structuredClone(options.personaPolicy) : undefined
    };
    this.audit.record({
      actor: { type: 'system', id: 'workflow-engine' },
      action: 'workflow.start',
      workflowRunId: run.id,
      detail: { workflowId: workflow.id }
    });
    return this.advance(workflow, run);
  }

  /**
   * Resume a paused run with human input or an approval decision. The caller
   * must supply an authenticated Principal (ADR-0010); the engine verifies the
   * principal holds the pending node's role and, once someone has acted in a
   * role, binds that role to them for the rest of the run (only the participant
   * who first acted in a role may act again for that role in this run).
   * Failed checks emit an audited 'workflow.authorization.denied' event and
   * throw AuthorizationError without altering the run.
   */
  async resume(
    workflow: WorkflowDefinition,
    runId: string,
    humanResponse: { principal: Principal; value?: unknown; approved?: boolean; reason?: string }
  ): Promise<WorkflowRun> {
    const run = this.store.load(runId);
    if (!run) throw new Error(`Unknown run '${runId}'`);
    if (run.status !== 'waitingForHuman' || !run.pending || !run.currentNodeId) {
      throw new Error(`Run '${runId}' is not waiting for human input`);
    }
    const node = this.node(workflow, run.currentNodeId);
    const { principal } = humanResponse;
    const actor = principalActor(principal);

    if (node.type !== 'humanInput' && node.type !== 'humanApproval') {
      throw new Error(`Node '${node.id}' is not a human step`);
    }
    authorizeHumanStep(run, node.role, principal, this.audit);

    const outcome = applyHumanResponse(run, node, humanResponse);
    this.audit.record({
      actor,
      action: outcome.audit.action,
      workflowRunId: run.id,
      nodeId: node.id,
      detail: outcome.audit.detail
    });
    return this.advance(workflow, outcome.run);
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
            const matched = branch.conditions.find((c) =>
              evaluateCondition(c.when, run.state, run.runPersonaPolicy)
            );
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
          personaId: node.persona ?? run.runPersonaId,
          workflowRunId: run.id,
          nodeId: node.id
        });
        if (node.output) run.state[node.output] = result.output;
        for (const entry of node.memoryWrite ?? []) {
          const text = entry.text.replace(
            /\{\{(\w+)\}\}/g,
            (_, key: string) => String(run.state[key] ?? '')
          );
          await this.agents.writeMemory(node.agent, text, entry.namespace);
        }
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

export { runConformanceSuite, devPrincipal } from './conformance.js';
export type { ConformanceResult, ConformanceStep } from './conformance.js';
