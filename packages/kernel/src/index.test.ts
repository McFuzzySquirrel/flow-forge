import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowForgeKernel, ENGINE_VERSION } from './index.js';
import { packWorkforce, unpackWorkforce, generateSigningKeypair } from '@flowforge/packaging';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { WorkflowEngine } from '@flowforge/workflow';
const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));
const testDataRoot = fileURLToPath(new URL('../../../.test-artifacts/kernel/', import.meta.url));

describe('FlowForgeKernel (in-memory)', () => {
  it('validates a package and reports errors for a missing directory', () => {
    const kernel = new FlowForgeKernel();
    expect(kernel.validatePackage(fixture)).toEqual({ valid: true, errors: [], graphErrors: [] });
    const invalid = kernel.validatePackage('/nonexistent/package');
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('includes graphErrors for a valid package', () => {
    const kernel = new FlowForgeKernel();
    const result = kernel.validatePackage(fixture);

    expect(result.graphErrors).toEqual([]);
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

  it('starts a run with a persona override', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);

    const run = await kernel.startRun(pkg.id, 'revision', { personaId: 'supportive-mentor' });

    expect(run.runPersonaId).toBe('supportive-mentor');
    const records = kernel.getAuditTrail({ runId: run.id }).records;
    expect(records.find((record) => record.action === 'agent.step')?.actor.persona).toBe(
      'supportive-mentor'
    );
  });

  it('exposes workflow definitions and identity providers for the UI (Phase 5)', async () => {
    const kernel = new FlowForgeKernel();
    const pkg = kernel.loadPackage(fixture);

    const workflow = kernel.getWorkflow(pkg.id, 'assignment');
    expect(workflow.nodes.some((n) => n.type === 'humanApproval')).toBe(true);
    expect(() => kernel.getWorkflow(pkg.id, 'nope')).toThrow(/Unknown workflow/);

    const providers = kernel.listIdentityProviders();
    expect(providers.some((p) => p.id === 'dev' && p.type === 'mock')).toBe(true);
  });

  it('signs in with OIDC-issued tokens through signInWithTokens (ADR-0010 / I.6)', async () => {
    const kernel = new FlowForgeKernel({
      identity: {
        providers: [{ id: 'entra', type: 'oidc', issuer: 'https://login.example.com/tenant', clientId: 'abc' }],
        roleMappings: [{ claim: 'groups', value: 'Staff', role: 'teacher' }]
      }
    });
    kernel.loadPackage(fixture);

    // Sign in with a mock token set the way the Electron main does after an
    // authorization-code + PKCE exchange. The mock provider is always
    // registered, so tokens are dev-style: accessToken maps to claims.
    const user = await kernel.signInWithTokens('dev', { accessToken: 'dev-teacher' });
    expect(user.roles).toContain('teacher');
    expect(kernel.getCurrentUser()?.id).toBe('dev-teacher');
  });
});

describe('FlowForgeKernel (package install & signing — Phase 4)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(testDataRoot, `install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('installs a signed archive and restores it across instances', () => {
    const archive = join(dataDir, 'pkg.workforce');
    packWorkforce(fixture, archive, { signingKey: generateSigningKeypair(), publisher: 'FlowForge' });

    const k1 = new FlowForgeKernel({ dataDir });
    const summary = k1.installWorkforceArchive(archive);
    expect(summary.signing?.signed).toBe(true);
    expect(summary.signing?.signerFingerprint).toBeTruthy();
    expect(k1.listPackages()).toHaveLength(1);

    const k2 = new FlowForgeKernel({ dataDir });
    const restored = k2.listPackages()[0]!;
    expect(restored.id).toBe(summary.id);
    expect(restored.signing?.signed).toBe(true);
    expect(restored.signing?.signerFingerprint).toBe(summary.signing?.signerFingerprint);
  });

  it('installs an unsigned archive but flags it unsigned', () => {
    const archive = join(dataDir, 'pkg.workforce');
    packWorkforce(fixture, archive);
    const k1 = new FlowForgeKernel({ dataDir });
    const summary = k1.installWorkforceArchive(archive);
    expect(summary.signing?.signed).toBe(false);
  });

  it('refuses a tampered archive at install time', () => {
    const archive = join(dataDir, 'pkg.workforce');
    const tampered = join(dataDir, 'tampered.workforce');
    packWorkforce(fixture, tampered, { signingKey: generateSigningKeypair() });

    // Tamper with the unpacked content and re-pack with the same key: hash manifest now disagrees.
    const unpackDir = join(dataDir, 'unpack');
    unpackWorkforce(tampered, unpackDir);
    writeFileSync(join(unpackDir, 'agents/planner/prompt.md'), '// tampered\n');
    packWorkforce(unpackDir, archive, { signingKey: generateSigningKeypair() });

    const k1 = new FlowForgeKernel({ dataDir });
    expect(() => k1.installWorkforceArchive(archive)).toThrow(/hash|integrity/i);
  });

  it('refuses a package whose engineVersion is not satisfied (Phase 4.1.5)', () => {
    // Craft a package directory that demands a newer engine.
    const pkgDir = join(dataDir, 'future-pkg');
    mkdirSync(join(pkgDir, 'agents', 'a'), { recursive: true });
    mkdirSync(join(pkgDir, 'workflows'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'workforce.json'),
      JSON.stringify({
        specVersion: '1.0',
        id: 'dev.flowforge.future',
        name: 'Future',
        version: '9.0.0',
        engineVersion: '>=2.0.0',
        agents: ['agents/a/agent.json'],
        workflows: ['workflows/w.json']
      })
    );
    writeFileSync(
      join(pkgDir, 'agents/a/agent.json'),
      JSON.stringify({ id: 'a', name: 'A', role: 'r', model: { tier: 'small' } })
    );
    writeFileSync(
      join(pkgDir, 'workflows/w.json'),
      JSON.stringify({ id: 'w', name: 'W', start: 'e', nodes: [{ id: 'e', type: 'end' }] })
    );

    const k1 = new FlowForgeKernel();
    expect(() => k1.loadPackage(pkgDir)).toThrow(/not compatible with engine/);
    expect(ENGINE_VERSION).toBeTruthy();
  });

  it('imports an externally-executed run and its audit records, preserving the chain', async () => {
    // Drive a run with a standalone engine + AuditLog, as the CLI does.
    const pkg = loadWorkforcePackage(fixture);
    const models = new ModelRegistry();
    const mock = new MockModelProvider(() => JSON.stringify({ note: 'mock' }));
    models.set('small', mock).set('medium', mock).set('large', mock);
    const audit = new AuditLog();
    const engine = new WorkflowEngine(
      new AgentRuntime(pkg, models, new MemoryService(), audit),
      audit
    );
    const run = await engine.start(pkg.workflows.get('assignment')!);
    const records = audit.all();

    const k1 = new FlowForgeKernel({ dataDir });
    const snapshot = k1.importRun(fixture, run, records);
    expect(snapshot.status).toBe('waitingForHuman');
    expect(k1.listRuns()).toHaveLength(1);
    expect(k1.getAuditTrail().chainIntact).toBe(true);

    const k2 = new FlowForgeKernel({ dataDir });
    expect(k2.listRuns()).toHaveLength(1);
    expect(k2.getAuditTrail().chainIntact).toBe(true);
  });
});

describe('FlowForgeKernel (file-backed persistence)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(testDataRoot, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
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
