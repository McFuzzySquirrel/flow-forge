import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DesktopKernel } from './kernel.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

describe('DesktopKernel', () => {
  it('validates a package and reports errors for a missing one', () => {
    const kernel = new DesktopKernel();
    expect(kernel.validatePackage(fixture)).toEqual({ valid: true, errors: [] });
    const invalid = kernel.validatePackage('/nonexistent/package');
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('loads a package and returns a serializable summary', () => {
    const kernel = new DesktopKernel();
    const summary = kernel.loadPackage(fixture);
    expect(summary.id).toBeTruthy();
    expect(summary.agents.length).toBeGreaterThan(0);
    expect(summary.workflows.length).toBeGreaterThan(0);
    expect(summary.workflows.some((workflow) => workflow.roles.length > 0)).toBe(true);
    // Everything crossing the IPC bridge must survive structured cloning.
    expect(() => structuredClone(summary)).not.toThrow();
  });

  it('refuses to resume a run when nobody is signed in (ADR-0010)', async () => {
    const kernel = new DesktopKernel();
    const pkg = kernel.loadPackage(fixture);
    const run = await kernel.startRun(pkg.id, pkg.workflows[0]!.id);
    expect(run.status).toBe('waitingForHuman');
    await expect(kernel.resumeRun(run.id, { value: 'hello' })).rejects.toThrow(/Sign in/);
  });

  it('signs in per role and enforces node roles on resume', async () => {
    const kernel = new DesktopKernel();
    const pkg = kernel.loadPackage(fixture);
    const workflow = pkg.workflows.find((candidate) => candidate.id === 'assignment') ?? pkg.workflows[0]!;
    let run = await kernel.startRun(pkg.id, workflow.id);
    expect(run.pending).toBeDefined();

    const wrongRole = workflow.roles.find((role) => role !== run.pending!.role);
    if (wrongRole) {
      await kernel.signIn(wrongRole);
      await expect(kernel.resumeRun(run.id, { value: 'nope' })).rejects.toThrow();
    }

    const user = await kernel.signIn(run.pending!.role);
    expect(user.roles).toContain(run.pending!.role);
    expect(kernel.getCurrentUser()?.id).toBe(user.id);

    run = await kernel.resumeRun(run.id, { value: 'A short assignment brief' });
    expect(run.participants?.[user.roles[0]!]).toBe(user.id);
    expect((await kernel.getRun(run.id))?.id).toBe(run.id);
  });

  it('drives the assignment workflow to completion and keeps the audit chain intact', async () => {
    const kernel = new DesktopKernel();
    const pkg = kernel.loadPackage(fixture);
    let run = await kernel.startRun(pkg.id, 'assignment');
    for (let step = 0; run.status === 'waitingForHuman' && run.pending && step < 20; step++) {
      await kernel.signIn(run.pending.role);
      run =
        run.pending.kind === 'input'
          ? await kernel.resumeRun(run.id, { value: 'response' })
          : await kernel.resumeRun(run.id, { approved: true, reason: 'looks good' });
    }
    expect(run.status).toBe('completed');
    const trail = kernel.getAuditTrail({ runId: run.id });
    expect(trail.chainIntact).toBe(true);
    expect(trail.records.length).toBeGreaterThan(0);
    expect(trail.records.some((record) => record.action === 'identity.login')).toBe(false); // login records have no runId
    const fullTrail = kernel.getAuditTrail();
    expect(fullTrail.records.some((record) => record.action === 'identity.login')).toBe(true);
    expect(() => structuredClone(trail)).not.toThrow();
  });

  it('signs out and forgets the current user', async () => {
    const kernel = new DesktopKernel();
    const pkg = kernel.loadPackage(fixture);
    const role = pkg.workflows.flatMap((workflow) => workflow.roles)[0]!;
    await kernel.signIn(role);
    expect(kernel.getCurrentUser()).toBeDefined();
    kernel.signOut();
    expect(kernel.getCurrentUser()).toBeUndefined();
  });
});
