import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowForgeKernel } from './index.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

describe('FlowForgeKernel (in-memory)', () => {
  it('validates a package and reports errors for a missing directory', () => {
    const kernel = new FlowForgeKernel();
    expect(kernel.validatePackage(fixture)).toEqual({ valid: true, errors: [] });
    const invalid = kernel.validatePackage('/nonexistent/package');
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('loads a package and returns a serializable summary with a dir field', () => {
    const kernel = new FlowForgeKernel();
    const summary = kernel.loadPackage(fixture);
    expect(summary.id).toBeTruthy();
    expect(summary.dir).toBe(fixture);
    expect(summary.agents.length).toBeGreaterThan(0);
    expect(summary.workflows.length).toBeGreaterThan(0);
    expect(() => structuredClone(summary)).not.toThrow();
  });

  it('listPackages returns all loaded packages', () => {
    const kernel = new FlowForgeKernel();
    expect(kernel.listPackages()).toHaveLength(0);
    const summary = kernel.loadPackage(fixture);
    expect(kernel.listPackages()).toHaveLength(1);
    expect(kernel.listPackages()[0]!.id).toBe(summary.id);
  });

  it('removePackage unloads a package', () => {
    const kernel = new FlowForgeKernel();
    const summary = kernel.loadPackage(fixture);
    kernel.removePackage(summary.id);
    expect(kernel.listPackages()).toHaveLength(0);
  });

  it('refuses to resume a run when nobody is signed in (ADR-0010)', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);
    const run = await kernel.startRun(pkg.id, pkg.workflows[0]!.id);
    expect(run.status).toBe('waitingForHuman');
    await expect(kernel.resumeRun(run.id, { value: 'hello' })).rejects.toThrow(/Sign in/);
  });

  it('signs in per role and enforces node roles on resume', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);
    const workflow = pkg.workflows.find((w) => w.id === 'assignment') ?? pkg.workflows[0]!;
    let run = await kernel.startRun(pkg.id, workflow.id);
    expect(run.pending).toBeDefined();

    const wrongRole = workflow.roles.find((r) => r !== run.pending!.role);
    if (wrongRole) {
      await kernel.signIn(wrongRole);
      await expect(kernel.resumeRun(run.id, { value: 'nope' })).rejects.toThrow();
    }

    const user = await kernel.signIn(run.pending!.role);
    expect(user.roles).toContain(run.pending!.role);
    run = await kernel.resumeRun(run.id, { value: 'A short assignment brief' });
    expect(run.participants?.[user.roles[0]!]).toBe(user.id);
  });

  it('listRuns returns started runs and getRun works', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);
    expect(kernel.listRuns()).toHaveLength(0);
    const run = await kernel.startRun(pkg.id, 'assignment');
    expect(kernel.listRuns()).toHaveLength(1);
    expect(kernel.listRuns(pkg.id)).toHaveLength(1);
    expect(kernel.listRuns('other-pkg')).toHaveLength(0);
    const fetched = await kernel.getRun(run.id);
    expect(fetched?.id).toBe(run.id);
  });

  it('getAuditTrail supports run and action filters', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);
    const run = await kernel.startRun(pkg.id, 'assignment');
    const all = kernel.getAuditTrail();
    expect(all.records.length).toBeGreaterThan(0);
    expect(all.chainIntact).toBe(true);
    const forRun = kernel.getAuditTrail({ runId: run.id });
    expect(forRun.records.every((r) => r.workflowRunId === run.id)).toBe(true);
    const starts = kernel.getAuditTrail({ action: 'workflow.start' });
    expect(starts.records.every((r) => r.action === 'workflow.start')).toBe(true);
  });

  it('drives the assignment workflow to completion and audit chain stays intact', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);
    let run = await kernel.startRun(pkg.id, 'assignment');

    // teacher creates assignment
    expect(run.pending?.role).toBe('teacher');
    await kernel.signIn('teacher');
    run = await kernel.resumeRun(run.id, {
      value: 'Solve one- and two-step linear equations, show working.'
    });

    // student submits
    expect(run.pending?.role).toBe('student');
    await kernel.signIn('student');
    run = await kernel.resumeRun(run.id, { value: 'x + 3 = 10; x = 7' });

    // teacher approves
    expect(run.pending?.role).toBe('teacher');
    await kernel.signIn('teacher');
    run = await kernel.resumeRun(run.id, { approved: true, reason: 'Correct method shown' });

    expect(run.status).toBe('completed');
    expect(kernel.getAuditTrail({ runId: run.id }).chainIntact).toBe(true);
  });
});

describe('FlowForgeKernel (file-backed persistence)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'flowforge-kernel-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists a loaded package across kernel instances', () => {
    const k1 = new FlowForgeKernel({ dataDir });
    k1.loadPackage(fixture);
    expect(k1.listPackages()).toHaveLength(1);

    const k2 = new FlowForgeKernel({ dataDir });
    expect(k2.listPackages()).toHaveLength(1);
    expect(k2.listPackages()[0]!.id).toBe(k1.listPackages()[0]!.id);
  });

  it('persists run state and run index across kernel instances', async () => {
    const k1 = new FlowForgeKernel({ dataDir });
    const pkg = k1.loadPackage(fixture);
    const run = await k1.startRun(pkg.id, 'assignment');
    expect(run.status).toBe('waitingForHuman');

    const k2 = new FlowForgeKernel({ dataDir });
    expect(k2.listRuns()).toHaveLength(1);
    const loaded = await k2.getRun(run.id);
    expect(loaded?.id).toBe(run.id);
    expect(loaded?.status).toBe('waitingForHuman');
  });

  it('extends the audit chain correctly across instances', async () => {
    const k1 = new FlowForgeKernel({ dataDir });
    const pkg = k1.loadPackage(fixture);
    await k1.startRun(pkg.id, 'assignment');
    const trailBefore = k1.getAuditTrail();

    const k2 = new FlowForgeKernel({ dataDir });
    // Load the package again so the engine is wired up; the audit file already has records.
    k2.loadPackage(fixture);
    await k2.startRun(pkg.id, 'assignment');

    const trailAfter = k2.getAuditTrail();
    expect(trailAfter.records.length).toBeGreaterThan(trailBefore.records.length);
    expect(trailAfter.chainIntact).toBe(true);
  });
});
