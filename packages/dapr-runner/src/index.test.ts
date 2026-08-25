/**
 * Dapr runner tests. The conformance suite (the same one the embedded runner
 * passes) is run against {@link DaprWorkflowRunner} using an in-process fake
 * DaprWorkflowClient that actually executes the registered orchestrator — so
 * the orchestrator translation is exercised end-to-end without needing a live
 * sidecar. A live-sidecar run uses the same code via `registerDaprWorkflows`.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowRun } from '@flowforge/core';
import { loadWorkforcePackage } from '@flowforge/packages';
import { MockModelProvider, ModelRegistry, AgentRuntime, type ModelProvider } from '@flowforge/agents';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { devPrincipal, runConformanceSuite } from '@flowforge/workflow';
import { createActivities, type ActivityRegistry } from './activities.js';
import { createWorkflowGenerator, type WorkflowContextLike } from './orchestrator.js';
import { DaprWorkflowRunner } from './runner.js';
import { InMemoryRunStore, HUMAN_TASK_EVENT, type DaprWorkflowClientLike } from './types.js';
import { DaprStateStoreAdapter } from './state.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

// ---------------------------------------------------------------------------
// In-process Dapr executor: drives a registered orchestrator to its next
// external-event wait (or completion), executing activities directly. This
// models Dapr's durable executor closely enough to prove the translation.
// ---------------------------------------------------------------------------

type TaggedTask = { kind: 'activity'; name: string; input: unknown } | { kind: 'event'; name: string };

interface Instance {
  gen: Generator<unknown, WorkflowRun, unknown>;
  waitingOn?: string;
  done: boolean;
  eventPayload?: unknown;
}

export function createInProcessDaprClient(
  workflows: Record<string, (input: WorkflowRun) => Generator<unknown, WorkflowRun, unknown>>,
  activities: ActivityRegistry
): DaprWorkflowClientLike {
  const instances = new Map<string, Instance>();

  async function drive(instance: Instance, resumeValue?: unknown): Promise<void> {
    let value = resumeValue;
    while (true) {
      const next = instance.gen.next(value);
      value = undefined;
      if (next.done) {
        instance.done = true;
        return;
      }
      const task = next.value as TaggedTask;
      if (task.kind === 'event') {
        instance.waitingOn = task.name;
        return;
      }
      const fn = activities[task.name];
      if (!fn) throw new Error(`Unknown activity '${task.name}'`);
      value = await fn(undefined, task.input);
    }
  }

  return {
    async scheduleNewWorkflow(name, input, instanceId) {
      const factory = workflows[name];
      if (!factory) throw new Error(`Unknown workflow '${name}'`);
      const instance: Instance = { gen: factory(input as WorkflowRun), done: false };
      instances.set(instanceId!, instance);
      await drive(instance);
      return instanceId!;
    },
    async raiseEvent(instanceId, eventName, payload) {
      const instance = instances.get(instanceId);
      if (!instance) throw new Error(`Unknown instance '${instanceId}'`);
      if (eventName !== instance.waitingOn) {
        throw new Error(`Instance '${instanceId}' is not waiting for '${eventName}'`);
      }
      instance.waitingOn = undefined;
      await drive(instance, payload);
    },
    async waitForWorkflowStart() {
      return { runtimeStatus: 'Running' };
    }
  };
}

// ---------------------------------------------------------------------------

function buildDaprRunner(workflow: WorkflowDefinition) {
  const pkg = loadWorkforcePackage(fixture);
  const provider: ModelProvider = new MockModelProvider(() =>
    JSON.stringify({ note: 'mock', score: 80, confidence: 0.9 })
  );
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const runStore = new InMemoryRunStore();
  const agents = new AgentRuntime(pkg, models, new MemoryService(), audit);
  const activities = createActivities({ runStore, agents, audit });
  const workflowGen = createWorkflowGenerator(workflow);
  const client = createInProcessDaprClient({ [workflow.id]: (input) => workflowGen(contextFor(), input) }, activities);
  const runner = new DaprWorkflowRunner(workflow, { client, runStore, audit });
  return { runner, audit, runStore };

  function contextFor(): WorkflowContextLike {
    return {
      callActivity: (name, input) => ({ kind: 'activity', name, input }) as TaggedTask,
      waitForExternalEvent: (name) => ({ kind: 'event', name }) as TaggedTask,
      setCustomStatus: () => undefined
    };
  }
}

describe('DaprWorkflowRunner (in-process executor)', () => {
  it('passes the conformance suite against the Grade7 assignment workflow', async () => {
    const pkg = loadWorkforcePackage(fixture);
    const workflow = pkg.workflows.get('assignment')!;
    const { runner, audit } = buildDaprRunner(workflow);

    const result = await runConformanceSuite(
      runner,
      workflow,
      [
        {
          role: 'teacher',
          principal: devPrincipal('teacher'),
          response: { value: 'Solve one- and two-step linear equations, show working.' },
          expectState: { assignment: 'Solve one- and two-step linear equations, show working.' }
        },
        {
          role: 'student',
          principal: devPrincipal('student'),
          response: { value: 'x + 3 = 10; x = 7' },
          expectState: { submission: 'x + 3 = 10; x = 7' }
        },
        {
          role: 'teacher',
          principal: devPrincipal('teacher'),
          response: { approved: true, reason: 'Correct method shown' }
        }
      ],
      audit
    );

    expect(result.stepsConsumed).toBe(3);
    expect(result.run.status).toBe('completed');
    expect(result.run.state.assessment).toBeDefined();
  });

  it('authorizes human steps (ADR-0010) and rejects the wrong role', async () => {
    const pkg = loadWorkforcePackage(fixture);
    const workflow = pkg.workflows.get('assignment')!;
    const { runner } = buildDaprRunner(workflow);

    let run = await runner.start();
    expect(run.pending?.role).toBe('teacher');
    await expect(
      runner.resume(run.id, { principal: devPrincipal('student'), value: 'not allowed' })
    ).rejects.toThrow(/not authorized/i);

    // The run is left untouched; the correct role can still act.
    run = await runner.resume(run.id, {
      principal: devPrincipal('teacher'),
      value: 'A valid assignment brief'
    });
    expect(run.pending?.role).toBe('student');
  });

  it('rejects a resume when the run is not waiting for a human', async () => {
    const pkg = loadWorkforcePackage(fixture);
    const workflow = pkg.workflows.get('assignment')!;
    const { runner } = buildDaprRunner(workflow);
    await expect(
      runner.resume('nope', { principal: devPrincipal('teacher'), value: 'x' })
    ).rejects.toThrow(/not waiting for human/i);
  });

  it('round-trips run state through DaprStateStoreAdapter', async () => {
    const map = new Map<string, string>();
    const stateClient: DaprStateClientLike = {
      state: {
        async save(_store, states) {
          for (const { key, value } of states) map.set(key, value);
        },
        async get(_store, key) {
          const value = map.get(key);
          return value === undefined ? undefined : { data: value };
        }
      }
    };
    const daprStore = new DaprStateStoreAdapter(stateClient);

    const pkg = loadWorkforcePackage(fixture);
    const workflow = pkg.workflows.get('assignment')!;
    const provider: ModelProvider = new MockModelProvider(() => JSON.stringify({ note: 'x' }));
    const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
    const audit = new AuditLog();
    const agents = new AgentRuntime(pkg, models, new MemoryService(), audit);
    const activities = createActivities({ runStore: daprStore, agents, audit });
    const generator = createWorkflowGenerator(workflow);
    const client = createInProcessDaprClient(
      { [workflow.id]: (input) => generator(ctxLike(), input) },
      activities
    );
    const runner = new DaprWorkflowRunner(workflow, { client, runStore: daprStore, audit });

    const run = await runner.start();
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending?.role).toBe('teacher');

    // State is persisted to the (fake) Dapr state store, not just memory.
    expect(map.size).toBeGreaterThan(0);
    const reloaded = await daprStore.load(run.id);
    expect(reloaded?.id).toBe(run.id);
    expect(audit.verify()).toBe(-1);
  });
});

function ctxLike(): WorkflowContextLike {
  return {
    callActivity: (name, input) => ({ kind: 'activity', name, input } as TaggedTask),
    waitForExternalEvent: (name) => ({ kind: 'event', name } as TaggedTask),
    setCustomStatus: () => undefined
  };
}

import type { DaprStateClientLike } from './types.js';

export { HUMAN_TASK_EVENT };
