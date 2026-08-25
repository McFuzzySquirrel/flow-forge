import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowForgeKernel } from './index.js';
import { FileVectorStore, MemoryService } from '@flowforge/memory';

const educationFixture = fileURLToPath(
  new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url)
);
const onboardingFixture = fileURLToPath(
  new URL('../../../fixtures/Corporate-Onboarding.workforce', import.meta.url)
);
const testDataRoot = fileURLToPath(new URL('../../../.test-artifacts/isolation/', import.meta.url));

/** Drive a workflow to completion using an ordered list of scripted human responses (CLI --answers model). */
async function driveToCompletion(
  kernel: FlowForgeKernel,
  packageId: string,
  workflowId: string,
  script: Array<{ value?: unknown; approved?: boolean; reason?: string }>
) {
  let run = await kernel.startRun(packageId, workflowId);
  let index = 0;
  while (run.status === 'waitingForHuman' && run.pending) {
    const response = script[index]!;
    index += 1;
    await kernel.signIn(run.pending.role);
    run = await kernel.resumeRun(run.id, response);
  }
  return run;
}

describe('Phase 4.2.3 — two packages run side by side, fully isolated', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(testDataRoot, `iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs both packages in one kernel with zero audit cross-contamination', async () => {
    const kernel = new FlowForgeKernel({ dataDir });
    kernel.loadPackage(educationFixture);
    kernel.loadPackage(onboardingFixture);
    expect(kernel.listPackages()).toHaveLength(2);

    const educationRun = await driveToCompletion(kernel, 'dev.flowforge.grade7-maths', 'assignment', [
      { value: 'Solve one- and two-step linear equations.' }, // teacher: create assignment
      { value: 'x + 3 = 10; x = 7' }, // student: submit
      { approved: true, reason: 'Looks good' } // teacher: approve
    ]);
    const onboardingRun = await driveToCompletion(
      kernel,
      'com.example.corporate-onboarding',
      'onboarding',
      [
        { value: 'Backend Engineer, starts Monday, contract received' }, // hr
        { value: 'I am Alex, backend engineer.' }, // employee
        { approved: true, reason: 'All good' }, // compliance-officer
        { approved: true, reason: 'Approved' } // manager
      ]
    );

    expect(educationRun.status).toBe('completed');
    expect(onboardingRun.status).toBe('completed');
    expect(kernel.listRuns()).toHaveLength(2);

    // Audit isolation: every record for the onboarding run belongs to onboarding actors.
    const onboardingTrail = kernel.getAuditTrail({ runId: onboardingRun.id }).records;
    expect(onboardingTrail.length).toBeGreaterThan(0);
    const onboardingActors = new Set(
      onboardingTrail
        .filter((record) => record.action === 'agent.step')
        .map((record) => record.actor.id)
    );
    expect([...onboardingActors].sort()).toEqual(['buddy', 'compliance', 'hr-planner', 'manager-review']);
    // No agent-step actor from one package leaks into the other run's trail.
    const educationTrail = kernel.getAuditTrail({ runId: educationRun.id }).records;
    const educationActors = new Set(
      educationTrail
        .filter((record) => record.action === 'agent.step')
        .map((record) => record.actor.id)
    );
    expect([...onboardingActors].every((actor) => !educationActors.has(actor))).toBe(true);
    expect(kernel.getAuditTrail().chainIntact).toBe(true);
  });

  it('keeps per-agent memory namespaces isolated across packages', async () => {
    const store = new FileVectorStore(dataDir);
    const educationMemory = new MemoryService(store);
    const onboardingMemory = new MemoryService(store);

    await educationMemory.remember(
      'dev.flowforge.grade7-maths/reflection',
      'The learner struggled with fractions but improved after substitution practice.'
    );

    const onboardingRecall = await onboardingMemory.recall('com.example.corporate-onboarding/buddy', 'fractions', 3);
    expect(onboardingRecall).toHaveLength(0);

    const educationRecall = await educationMemory.recall(
      'dev.flowforge.grade7-maths/reflection',
      'fractions',
      3
    );
    expect(educationRecall.length).toBeGreaterThan(0);
  });
});
