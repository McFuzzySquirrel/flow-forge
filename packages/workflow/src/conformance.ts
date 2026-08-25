/**
 * Runner conformance suite (Phase 4.3.5).
 *
 * One spec, N runners: this suite drives any {@link WorkflowRunner} through the
 * same scripted human-in-the-loop scenario and asserts the same observable
 * contract — status transitions, pending human tasks, state mutations and an
 * intact audit chain. Both the embedded runner and the Dapr runner must pass
 * it. If a second runner needs a third, it just calls the same suite.
 */
import type { Principal, WorkflowDefinition } from '@flowforge/core';
import { AuditLog } from '@flowforge/audit';
import type { WorkflowRun, WorkflowRunner } from './index.js';

export interface ConformanceStep {
  /** Expected pending human role before this step runs. */
  role: string;
  principal: Principal;
  response: { value?: unknown; approved?: boolean; reason?: string };
  /** After resume, expected values of run.state keys (subset). */
  expectState?: Record<string, unknown>;
}

export interface ConformanceResult {
  run: WorkflowRun;
  audit: AuditLog;
  stepsConsumed: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

/**
 * Drive a runner through a scripted scenario and assert the contract.
 *
 * @param runner       any WorkflowRunner implementation
 * @param workflow     the bound workflow definition (for start-state checks)
 * @param steps        ordered human steps with expected roles
 * @param audit        the AuditLog the runner records into (chain verified at end)
 * @param initial      optional initial state to seed the run
 */
export async function runConformanceSuite(
  runner: WorkflowRunner,
  workflow: WorkflowDefinition,
  steps: ConformanceStep[],
  audit: AuditLog,
  initial: Record<string, unknown> = {}
): Promise<ConformanceResult> {
  let run = await runner.start({ initialState: initial });

  for (const step of steps) {
    assert(run.status === 'waitingForHuman', `expected waitingForHuman before step, got ${run.status}`);
    assert(
      run.pending?.role === step.role,
      `expected pending role '${step.role}' but got '${run.pending?.role}'`
    );
    run = await runner.resume(run.id, { principal: step.principal, ...step.response });
    if (step.expectState) {
      for (const [key, value] of Object.entries(step.expectState)) {
        assert(
          run.state[key] === value,
          `state['${key}'] expected ${JSON.stringify(value)} but got ${JSON.stringify(run.state[key])}`
        );
      }
    }
  }

  assert(run.status === 'completed', `expected final status 'completed', got '${run.status}'`);
  assert(run.error === undefined, `run failed with: ${run.error}`);

  const chainIndex = audit.verify();
  assert(chainIndex === -1, `audit hash chain broken at index ${chainIndex}`);

  return { run, audit, stepsConsumed: steps.length };
}

/** Build a dev principal with a single role (mirrors the CLI dev identity). */
export function devPrincipal(role: string): Principal {
  return { id: `dev-${role}`, displayName: `Dev ${role}`, provider: 'dev', roles: [role] };
}
