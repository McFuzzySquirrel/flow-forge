/**
 * DesktopKernel — the kernel composition that backs the IPC surface
 * (Task 2.1.3). It is deliberately Electron-free so it can be unit-tested
 * with Vitest; `main.ts` is a thin adapter that maps IPC channels onto these
 * methods. All returned values are plain, JSON-serializable snapshots.
 *
 * Identity (Task 2.1.6 / I.6, dev-identity slice): the kernel hosts an
 * IdentityService with the mock 'dev' provider — one user per workflow role —
 * and every resume passes the signed-in Principal so the workflow engine's
 * role checks and per-run participant bindings (ADR-0010) are enforced.
 * Tokens and sessions never leave this process.
 */
import type { IdentityConfig, LoadedWorkforcePackage, Principal, WorkflowDefinition } from '@flowforge/core';
import { loadWorkforcePackage, PackageValidationError } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry, type ModelProvider } from '@flowforge/agents';
import { IdentityService, MockIdentityProvider } from '@flowforge/identity';
import { WorkflowEngine, type WorkflowRun } from '@flowforge/workflow';
import type {
  AuditTrailSnapshot,
  HumanResponse,
  PackageSummary,
  PackageValidationResult,
  RunSnapshot,
  UserSnapshot
} from './ipc.js';

interface LoadedPackageEntry {
  pkg: LoadedWorkforcePackage;
  engine: WorkflowEngine;
}

function humanRoles(workflow: WorkflowDefinition): string[] {
  return [
    ...new Set(
      workflow.nodes.flatMap((node) =>
        node.type === 'humanInput' || node.type === 'humanApproval' ? [node.role] : []
      )
    )
  ];
}

function toPackageSummary(pkg: LoadedWorkforcePackage): PackageSummary {
  return {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    description: pkg.manifest.description,
    agents: [...pkg.agents.values()].map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      modelTier: agent.model.tier,
      skills: agent.skills ?? [],
      defaultPersona: agent.defaultPersona
    })),
    workflows: [...pkg.workflows.values()].map((workflow) => ({
      id: workflow.id,
      description: workflow.description,
      nodeCount: workflow.nodes.length,
      roles: humanRoles(workflow)
    }))
  };
}

function toRunSnapshot(run: WorkflowRun, packageId: string): RunSnapshot {
  return {
    id: run.id,
    packageId,
    workflowId: run.workflowId,
    status: run.status,
    currentNodeId: run.currentNodeId,
    pending: run.pending,
    participants: run.participants,
    error: run.error
  };
}

function toUserSnapshot(principal: Principal): UserSnapshot {
  return {
    id: principal.id,
    displayName: principal.displayName,
    provider: principal.provider,
    roles: principal.roles
  };
}

export class DesktopKernel {
  private readonly audit = new AuditLog();
  private readonly packages = new Map<string, LoadedPackageEntry>();
  private readonly runs = new Map<string, { packageId: string; workflowId: string }>();
  private readonly modelProvider: ModelProvider;
  private identity?: IdentityService;
  private sessionId?: string;

  constructor(options: { modelProvider?: ModelProvider } = {}) {
    this.modelProvider =
      options.modelProvider ?? new MockModelProvider(() => JSON.stringify({ note: 'mock response' }));
  }

  validatePackage(packageDir: string): PackageValidationResult {
    try {
      loadWorkforcePackage(packageDir);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof PackageValidationError) return { valid: false, errors: error.errors };
      return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  loadPackage(packageDir: string): PackageSummary {
    const pkg = loadWorkforcePackage(packageDir);
    const models = new ModelRegistry()
      .set('small', this.modelProvider)
      .set('medium', this.modelProvider)
      .set('large', this.modelProvider);
    const engine = new WorkflowEngine(new AgentRuntime(pkg, models, new MemoryService(), this.audit), this.audit);
    this.packages.set(pkg.manifest.id, { pkg, engine });
    this.rebuildIdentity();
    return toPackageSummary(pkg);
  }

  async startRun(packageId: string, workflowId: string): Promise<RunSnapshot> {
    const { pkg, engine } = this.entry(packageId);
    const workflow = pkg.workflows.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow '${workflowId}' in package '${packageId}'`);
    const run = await engine.start(workflow);
    this.runs.set(run.id, { packageId, workflowId });
    return toRunSnapshot(run, packageId);
  }

  async resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot> {
    const ref = this.runs.get(runId);
    if (!ref) throw new Error(`Unknown run '${runId}'`);
    const principal = this.currentPrincipal();
    if (!principal) throw new Error('Sign in before responding to a human task (ADR-0010)');
    const { pkg, engine } = this.entry(ref.packageId);
    const workflow = pkg.workflows.get(ref.workflowId);
    if (!workflow) throw new Error(`Unknown workflow '${ref.workflowId}' in package '${ref.packageId}'`);
    const run = await engine.resume(workflow, runId, { principal, ...response });
    return toRunSnapshot(run, ref.packageId);
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const ref = this.runs.get(runId);
    if (!ref) return undefined;
    const { engine } = this.entry(ref.packageId);
    const run = engine.getRun(runId);
    return run ? toRunSnapshot(run, ref.packageId) : undefined;
  }

  getAuditTrail(runId?: string): AuditTrailSnapshot {
    const records = this.audit.all();
    return {
      records: runId ? records.filter((record) => record.workflowRunId === runId) : records,
      chainIntact: this.audit.verify() === -1
    };
  }

  /** Dev-identity sign-in: one mock user per workflow role (Task 2.1.6 / I.6). */
  async signIn(role: string): Promise<UserSnapshot> {
    if (!this.identity) throw new Error('Load a package before signing in');
    if (this.sessionId) this.signOut();
    const session = await this.identity.login('dev', { accessToken: `dev-${role}` });
    this.sessionId = session.id;
    return toUserSnapshot(session.principal);
  }

  signOut(): void {
    if (this.identity && this.sessionId) this.identity.logout(this.sessionId);
    this.sessionId = undefined;
  }

  getCurrentUser(): UserSnapshot | undefined {
    const principal = this.currentPrincipal();
    return principal ? toUserSnapshot(principal) : undefined;
  }

  private entry(packageId: string): LoadedPackageEntry {
    const entry = this.packages.get(packageId);
    if (!entry) throw new Error(`Package '${packageId}' is not loaded`);
    return entry;
  }

  private currentPrincipal(): Principal | undefined {
    if (!this.identity || !this.sessionId) return undefined;
    return this.identity.getSession(this.sessionId)?.principal;
  }

  /** Rebuild the dev identity service over all roles of the loaded packages. */
  private rebuildIdentity(): void {
    const roles = new Set<string>();
    for (const { pkg } of this.packages.values()) {
      for (const workflow of pkg.workflows.values()) {
        for (const role of humanRoles(workflow)) roles.add(role);
      }
    }
    const config: IdentityConfig = {
      providers: [{ id: 'dev', type: 'mock' }],
      roleMappings: [...roles].map((role) => ({ claim: 'role', value: role, role }))
    };
    const service = IdentityService.fromConfig(config, this.audit);
    const provider = service.registry.get('dev') as MockIdentityProvider;
    for (const role of roles) {
      provider.addUser(`dev-${role}`, { sub: `dev-${role}`, name: `Dev ${role}`, role });
    }
    this.identity = service;
    this.sessionId = undefined;
  }
}
