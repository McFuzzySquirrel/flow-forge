/**
 * FlowForgeKernel — the reference KernelApi implementation (ADR-0011).
 *
 * Deliberately framework-free: no Electron, no HTTP server, no event loop
 * assumption.  Any transport adapter (Electron IPC, HTTP, direct call from
 * the CLI) wraps an instance of this class.
 *
 * Persistence (optional):
 *   Pass `{ dataDir: '/path/to/.flowforge' }` to enable cross-process state:
 *   - `{dataDir}/packages.json`    — installed package registry
 *   - `{dataDir}/run-index.json`   — run → {packageId, workflowId} mapping
 *   - `{dataDir}/runs/{id}.json`   — individual run state (FileStateStore)
 *   - `{dataDir}/audit.jsonl`      — hash-chained audit log (FileAuditSink)
 *
 *   Without `dataDir` (e.g. in tests) everything is in-memory.
 *
 * Identity: hosts a dev identity service (one mock user per workflow role).
 * Real OIDC authorization-code + PKCE is a Phase-5 UI concern (ADR-0011).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentDefinition,
  IdentityConfig,
  LoadedWorkforcePackage,
  Principal,
  WorkflowDefinition
} from '@flowforge/core';
import { validate } from '@flowforge/core';
import { loadWorkforcePackage, PackageValidationError } from '@flowforge/packages';
import {
  checkEngineCompatibility,
  unpackWorkforce,
  verifyWorkforceArchive
} from '@flowforge/packaging';
import { AuditLog, FileAuditSink } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import {
  AgentRuntime,
  MockModelProvider,
  ModelRegistry,
  type ModelProvider
} from '@flowforge/agents';
import { IdentityService, MockIdentityProvider } from '@flowforge/identity';
import {
  FileStateStore,
  InMemoryStateStore,
  WorkflowEngine,
  validateGraph,
  type StateStore
} from '@flowforge/workflow';
import type {
  AgentSummary,
  AuditFilter,
  AuditTrailSnapshot,
  GovernanceSummary,
  HumanResponse,
  IdentityProviderSummary,
  KernelApi,
  PackageSummary,
  PackageValidationResult,
  RunSnapshot,
  WorkflowSummary,
  TokenSetLike,
  UserSnapshot
} from './api.js';
import type { AuditRecord } from '@flowforge/core';
import type { WorkflowRun } from '@flowforge/workflow';
import {
  defaultConfig,
  resolveModelRegistry,
  saveConfig,
  type FlowForgeConfig,
  type ModelConfigSnapshot
} from './config.js';
import {
  InMemoryMessagingTransport,
  type MessageFilter,
  type MessageRecord,
  type MessagingTransport,
  type SendMessageInput
} from './messaging.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface LoadedPackageEntry {
  pkg: LoadedWorkforcePackage;
  engine: WorkflowEngine;
  /** Provenance recorded when the package was installed (Phase 4). */
  signing?: { signed: boolean; signerFingerprint?: string; publisher?: string };
}

interface RunIndexEntry {
  packageId: string;
  workflowId: string;
}

/** The engine version published by this kernel, matched against `manifest.engineVersion`. */
export const ENGINE_VERSION = '0.1.0';

function humanRoles(workflow: WorkflowDefinition): string[] {
  return [
    ...new Set(
      workflow.nodes.flatMap((node) =>
        node.type === 'humanInput' || node.type === 'humanApproval' ? [node.role] : []
      )
    )
  ];
}

function toPackageSummary(pkg: LoadedWorkforcePackage, signing?: LoadedPackageEntry['signing']): PackageSummary {
  return {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    description: pkg.manifest.description,
    dir: pkg.rootDir,
    agents: [...pkg.agents.values()].map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      modelTier: agent.model.tier,
      skills: agent.skills ?? [],
      defaultPersona: agent.defaultPersona
    })),
    skills: [...pkg.skills.values()].map((skill) => ({
      id: skill.manifest.name,
      displayName: skill.manifest.metadata?.displayName,
      description: skill.manifest.description
    })),
    workflows: [...pkg.workflows.values()].map((workflow) => ({
      id: workflow.id,
      description: workflow.description,
      nodeCount: workflow.nodes.length,
      roles: humanRoles(workflow)
    })),
    ...(pkg.manifest.branding ? { branding: pkg.manifest.branding } : {}),
    ...(signing ? { signing } : {})
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
    ...(run.runPersonaId ? { runPersonaId: run.runPersonaId } : {}),
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

const CHAIN_FIELDS = new Set(['id', 'timestamp', 'hash', 'previousHash']);

/** Drop the hash-chain-generated fields from a record before re-recording it. */
function stripChainFields(record: AuditRecord): Omit<AuditRecord, 'id' | 'timestamp' | 'hash' | 'previousHash'> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CHAIN_FIELDS.has(key)) clean[key] = value;
  }
  return clean as Omit<AuditRecord, 'id' | 'timestamp' | 'hash' | 'previousHash'>;
}

// ---------------------------------------------------------------------------
// FlowForgeKernel
// ---------------------------------------------------------------------------

export interface FlowForgeKernelOptions {
  /** Absolute path to a data directory for persistence.  Omit for in-memory. */
  dataDir?: string;
  /** Model provider override (defaults to MockModelProvider). */
  modelProvider?: ModelProvider;
  /** Model registry override, typically built from flowforge.config.json. */
  modelRegistry?: ModelRegistry;
  /** Secret-free runtime config used to build providers and expose admin settings. */
  modelConfig?: FlowForgeConfig;
  /** Path to the secret-free runtime config file. */
  configPath?: string;
  /** Environment used to resolve provider-specific API keys. */
  env?: NodeJS.ProcessEnv;
  /** Deployment identity configuration (OIDC providers + role mappings). When
   *  omitted the kernel uses a dev identity (one mock user per workflow role). */
  identity?: IdentityConfig;
  /** Messaging transport abstraction for human↔human and human↔agent messaging. */
  messaging?: MessagingTransport;
}

export class FlowForgeKernel implements KernelApi {
  private readonly audit: AuditLog;
  private readonly stateStore: StateStore;
  private readonly dataDir: string | undefined;
  private readonly identityConfig?: IdentityConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackModelProvider: ModelProvider;
  private readonly messaging: MessagingTransport;
  private readonly configPath?: string;
  private hasConfiguredModels: boolean;
  private modelConfig: FlowForgeConfig;
  private modelConfigWarning?: string;
  private modelRegistry?: ModelRegistry;

  /** Loaded packages, keyed by package id. */
  private readonly loadedPackages = new Map<string, LoadedPackageEntry>();
  /** Mapping from run id to its owning package and workflow. */
  private readonly runIndex = new Map<string, RunIndexEntry>();

  private identity?: IdentityService;
  private sessionId?: string;

  constructor(options: FlowForgeKernelOptions = {}) {
    this.dataDir = options.dataDir;
    this.identityConfig = options.identity;
    this.env = options.env ?? process.env;
    this.configPath = options.configPath;
    this.fallbackModelProvider =
      options.modelProvider ?? new MockModelProvider(() => JSON.stringify({ note: 'mock response' }));
    this.hasConfiguredModels = options.modelConfig !== undefined || options.modelRegistry !== undefined;
    this.modelConfig = structuredClone(options.modelConfig ?? defaultConfig());
    this.modelRegistry = options.modelRegistry;
    this.messaging = options.messaging ?? new InMemoryMessagingTransport();

    if (options.dataDir) {
      const runsDir = join(options.dataDir, 'runs');
      mkdirSync(runsDir, { recursive: true });
      this.stateStore = new FileStateStore(runsDir);
      this.audit = new AuditLog(new FileAuditSink(join(options.dataDir, 'audit.jsonl')));
      // Restore run index and package registry from disk.
      for (const [id, entry] of Object.entries(this.readJsonFile<Record<string, RunIndexEntry>>('run-index.json', {}))) {
        this.runIndex.set(id, entry);
      }
      for (const [, entry] of Object.entries(
        this.readJsonFile<Record<string, { dir: string; signing?: LoadedPackageEntry['signing'] }>>(
          'packages.json',
          {}
        )
      )) {
        try {
          this.loadPackageInternal(entry.dir, entry.signing);
        } catch {
          // skip packages whose directory is no longer valid
        }
      }
    } else {
      this.stateStore = new InMemoryStateStore();
      this.audit = new AuditLog();
    }
  }

  // ---- Packages -----------------------------------------------------------

  validatePackage(packageDir: string): PackageValidationResult {
    try {
      const pkg = loadWorkforcePackage(packageDir);
      const graphErrors = [...pkg.workflows.values()].flatMap((workflow) =>
        validateGraph(workflow).map((error) => `${workflow.id}: ${error}`)
      );
      return { valid: graphErrors.length === 0, errors: [], graphErrors };
    } catch (error) {
      if (error instanceof PackageValidationError) {
        return { valid: false, errors: error.errors, graphErrors: [] };
      }
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        graphErrors: []
      };
    }
  }

  loadPackage(packageDir: string): PackageSummary {
    const summary = this.loadPackageInternal(packageDir);
    if (this.dataDir) this.savePackageRegistry();
    return summary;
  }

  /**
   * Install a package from a `.workforce` archive.  Verifies integrity and
   * signature first, unpacks into the data directory and loads it.  Tampered
   * or engine-incompatible archives are refused; unsigned ones install but
   * surface the unsigned provenance on the returned summary (Phase 4.1.4).
   */
  installWorkforceArchive(archivePath: string): PackageSummary {
    if (!this.dataDir) {
      throw new Error('installWorkforceArchive requires a dataDir (pass { dataDir } to FlowForgeKernel)');
    }
    const result = verifyWorkforceArchive(archivePath, { engineVersion: ENGINE_VERSION });
    if (!result.hashesIntact || !result.valid) {
      throw new Error(`Refusing to install ${archivePath}:\n  ${result.errors.join('\n  ')}`);
    }
    if (result.signed && result.signatureValid !== true) {
      throw new Error(`Refusing to install ${archivePath}: signature is invalid`);
    }
    const id = result.packageId;
    const version = result.packageVersion;
    if (!id || !version) {
      throw new Error(`Refusing to install ${archivePath}: archive manifest is missing package id/version`);
    }
    const destDir = join(this.dataDir, 'packages', `${id}-${version}`);
    unpackWorkforce(archivePath, destDir);
    const signing = {
      signed: result.signed,
      ...(result.signed
        ? { signerFingerprint: result.signerFingerprint, publisher: undefined as string | undefined }
        : {})
    };
    const summary = this.loadPackageInternal(destDir, signing);
    this.savePackageRegistry();
    return summary;
  }

  listPackages(): PackageSummary[] {
    return [...this.loadedPackages.values()].map(({ pkg, signing }) => toPackageSummary(pkg, signing));
  }

  removePackage(packageId: string): void {
    this.loadedPackages.delete(packageId);
    this.rebuildIdentity();
    if (this.dataDir) this.savePackageRegistry();
  }

  // ---- Runs ---------------------------------------------------------------

  async startRun(
    packageId: string,
    workflowId: string,
    options: { personaId?: string } = {}
  ): Promise<RunSnapshot> {
    const { pkg, engine } = this.entry(packageId);
    const workflow = pkg.workflows.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow '${workflowId}' in package '${packageId}'`);
    const persona = options.personaId ? pkg.personas.get(options.personaId) : undefined;
    if (options.personaId && !persona) throw new Error(`Unknown persona '${options.personaId}'`);
    const run = await engine.start(
      workflow,
      options.personaId
        ? {
            personaId: options.personaId,
            personaPolicy: persona?.decisionPolicy
              ? ({ ...persona.decisionPolicy } as Record<string, unknown>)
              : undefined
          }
        : undefined
    );
    this.runIndex.set(run.id, { packageId, workflowId });
    if (this.dataDir) this.saveRunIndex();
    return toRunSnapshot(run, packageId);
  }

  async resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot> {
    const ref = this.runIndex.get(runId);
    if (!ref) throw new Error(`Unknown run '${runId}'`);
    const principal = this.currentPrincipal();
    if (!principal) throw new Error('Sign in before responding to a human task (ADR-0010)');
    const { pkg, engine } = this.entry(ref.packageId);
    const workflow = pkg.workflows.get(ref.workflowId);
    if (!workflow) throw new Error(`Unknown workflow '${ref.workflowId}' in package '${ref.packageId}'`);
    const run = await engine.resume(workflow, runId, { principal, ...response });
    return toRunSnapshot(run, ref.packageId);
  }

  listRuns(packageId?: string): RunSnapshot[] {
    const results: RunSnapshot[] = [];
    for (const [runId, ref] of this.runIndex) {
      if (packageId && ref.packageId !== packageId) continue;
      const run = this.stateStore.load(runId);
      if (run) results.push(toRunSnapshot(run, ref.packageId));
    }
    return results;
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const ref = this.runIndex.get(runId);
    if (!ref) return undefined;
    const run = this.stateStore.load(runId);
    return run ? toRunSnapshot(run, ref.packageId) : undefined;
  }

  /**
   * Import a run that was executed outside this kernel (the CLI drives its own
   * engine) plus its audit records, so persisted runs and the audit trail
   * reflect headless CLI runs too. Records are re-chained into this kernel's
   * audit log so integrity is preserved across sources.
   */
  importRun(packageDir: string, run: WorkflowRun, auditRecords: AuditRecord[]): RunSnapshot {    if (!this.dataDir) {
      throw new Error('importRun requires a dataDir (pass { dataDir } to FlowForgeKernel)');
    }
    const pkg = this.loadPackageInternal(packageDir);
    this.stateStore.save(run);
    this.runIndex.set(run.id, { packageId: pkg.id, workflowId: run.workflowId });
    for (const record of auditRecords) {
      // Strip the chain-generated fields so re-recording chains cleanly; the
      // kernel's AuditLog regenerates id/timestamp/hashes for this log.
      this.audit.record(stripChainFields(record));
    }
    this.saveRunIndex();
    this.savePackageRegistry();
    return toRunSnapshot(run, pkg.id);
  }

  // ---- Audit --------------------------------------------------------------

  getAuditTrail(filter?: AuditFilter): AuditTrailSnapshot {
    let records = this.audit.all();
    const runIds = new Set([filter?.runId, ...(filter?.runIds ?? [])].filter((value): value is string => Boolean(value)));
    if (runIds.size > 0) {
      records = records.filter((r) => Boolean(r.workflowRunId && runIds.has(r.workflowRunId)));
    }
    if (filter?.actor) records = records.filter((r) => r.actor.id === filter.actor);
    if (filter?.action) records = records.filter((r) => r.action === filter.action);
    return { records, chainIntact: this.audit.verify() === -1 };
  }

  // ---- Workflows (read-only graph access) ---------------------------------

  getWorkflow(packageId: string, workflowId: string): WorkflowDefinition {
    const { pkg } = this.entry(packageId);
    const workflow = pkg.workflows.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow '${workflowId}' in package '${packageId}'`);
    return workflow;
  }

  saveWorkflow(packageId: string, workflow: WorkflowDefinition): WorkflowSummary {
    const entry = this.entry(packageId);
    const relPath = entry.pkg.workflowFiles.get(workflow.id);
    if (!relPath) throw new Error(`Unknown workflow '${workflow.id}' in package '${packageId}'`);
    const validation = validate('workflow', workflow);
    if (!validation.valid) {
      throw new Error(`Invalid workflow '${workflow.id}': ${validation.errors.join('; ')}`);
    }
    writeFileSync(join(entry.pkg.rootDir, relPath), `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    const reloaded = this.loadPackageInternal(entry.pkg.rootDir, entry.signing);
    const summary = reloaded.workflows.find((candidate) => candidate.id === workflow.id);
    if (!summary) throw new Error(`Workflow '${workflow.id}' disappeared after save`);
    return summary;
  }

  updateAgentSkills(packageId: string, agentId: string, skills: string[]): AgentSummary {
    const entry = this.entry(packageId);
    const relPath = entry.pkg.agentFiles.get(agentId);
    if (!relPath) throw new Error(`Unknown agent '${agentId}' in package '${packageId}'`);
    const nextSkills = [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))];
    for (const skill of nextSkills) {
      if (!entry.pkg.skills.has(skill)) throw new Error(`Unknown skill '${skill}' in package '${packageId}'`);
    }
    const agentPath = join(entry.pkg.rootDir, relPath);
    const current = JSON.parse(readFileSync(agentPath, 'utf8')) as AgentDefinition;
    const updated: AgentDefinition = { ...current, skills: nextSkills };
    const validation = validate('agent', updated);
    if (!validation.valid) throw new Error(`Invalid agent '${agentId}': ${validation.errors.join('; ')}`);
    writeFileSync(agentPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    const reloaded = this.loadPackageInternal(entry.pkg.rootDir, entry.signing);
    const summary = reloaded.agents.find((candidate) => candidate.id === agentId);
    if (!summary) throw new Error(`Agent '${agentId}' disappeared after save`);
    return summary;
  }

  getModelConfig(): ModelConfigSnapshot {
    return {
      ...(this.configPath ? { configPath: this.configPath } : {}),
      provider: structuredClone(this.modelConfig.provider),
      ...(this.modelConfigWarning ? { warning: this.modelConfigWarning } : {})
    };
  }

  updateModelConfig(config: ModelConfigSnapshot): ModelConfigSnapshot {
    this.hasConfiguredModels = true;
    this.modelConfig = { ...this.modelConfig, provider: structuredClone(config.provider) };
    if (this.configPath) saveConfig(this.modelConfig, this.configPath);
    try {
      this.modelRegistry = resolveModelRegistry(undefined, undefined, this.modelConfig, this.env);
      this.modelConfigWarning = undefined;
    } catch (error) {
      this.modelRegistry = undefined;
      this.modelConfigWarning = error instanceof Error ? error.message : String(error);
    }
    this.reloadLoadedPackages();
    return this.getModelConfig();
  }

  // ---- Identity -----------------------------------------------------------

  listIdentityProviders(): IdentityProviderSummary[] {
    if (!this.identity) return [];
    return this.identity.registry.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      type: provider.type
    }));
  }

  getGovernance(): GovernanceSummary {
    const records = this.audit.all();
    const byActor = new Map<string, { provider?: string; roles: Set<string>; count: number; last?: string }>();
    for (const record of records) {
      let entry = byActor.get(record.actor.id);
      if (!entry) {
        entry = { roles: new Set(), count: 0 };
        byActor.set(record.actor.id, entry);
      }
      entry.count += 1;
      entry.last = record.action;
      if (record.actor.provider) entry.provider = record.actor.provider;
      for (const role of record.actor.roles ?? []) entry.roles.add(role);
    }
    return {
      providers: this.identity?.registry.list().map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        type: provider.type
      })) ?? [],
      roleMappings: this.identityConfig?.roleMappings ?? [],
      permissions: (this.identityConfig?.permissions ?? {}) as Record<string, string[]>,
      session: this.identityConfig?.session ?? { ttlSeconds: 8 * 60 * 60 },
      userAudit: [...byActor.entries()]
        .map(([actorId, entry]) => ({
          actorId,
          provider: entry.provider,
          roles: [...entry.roles].sort(),
          recordCount: entry.count,
          lastAction: entry.last
        }))
        .sort((a, b) => b.recordCount - a.recordCount)
    };
  }

  async signIn(role: string): Promise<UserSnapshot> {
    if (!this.identity) throw new Error('Load a package before signing in');
    if (this.sessionId) this.signOut();
    const session = await this.identity.login('dev', { accessToken: `dev-${role}` });
    this.sessionId = session.id;
    return toUserSnapshot(session.principal);
  }

  async signInWithTokens(providerId: string, tokens: TokenSetLike): Promise<UserSnapshot> {
    if (!this.identity) throw new Error('Load a package before signing in');
    if (this.sessionId) this.signOut();
    const session = await this.identity.login(providerId, tokens);
    this.sessionId = session.id;
    return toUserSnapshot(session.principal);
  }

  async beginOidcLogin(
    providerId: string,
    redirectUri: string
  ): Promise<{ url: string; state: string; codeVerifier: string }> {
    if (!this.identity) throw new Error('Load a package before signing in');
    const provider = this.identity.registry.get(providerId);
    if (provider.type !== 'oidc') throw new Error(`Provider '${providerId}' does not support OIDC flows`);
    const request = await provider.beginAuthorization(redirectUri);
    return { url: request.url, state: request.state, codeVerifier: request.codeVerifier };
  }

  async completeOidcLogin(
    providerId: string,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<UserSnapshot> {
    if (!this.identity) throw new Error('Load a package before signing in');
    const provider = this.identity.registry.get(providerId);
    const tokens = await provider.exchangeCode(code, codeVerifier, redirectUri);
    return this.signInWithTokens(providerId, tokens);
  }

  signOut(): void {
    if (this.identity && this.sessionId) this.identity.logout(this.sessionId);
    this.sessionId = undefined;
  }

  getCurrentUser(): UserSnapshot | undefined {
    const principal = this.currentPrincipal();
    return principal ? toUserSnapshot(principal) : undefined;
  }

  async listMessages(filter?: MessageFilter): Promise<MessageRecord[]> {
    return this.messaging.listMessages(filter);
  }

  async sendMessage(message: SendMessageInput): Promise<MessageRecord> {
    const principal = this.currentPrincipal();
    if (!principal) throw new Error('Sign in before sending a message');
    const created = await this.messaging.sendMessage({
      createdAt: new Date().toISOString(),
      sender: {
        type: 'human',
        id: principal.id,
        provider: principal.provider,
        roles: principal.roles
      },
      recipient: message.recipient,
      content: message.content,
      workflowRunId: message.workflowRunId,
      packageId: message.packageId
    });
    this.audit.record({
      actor: { type: 'human', id: principal.id, provider: principal.provider, roles: principal.roles },
      action: 'message.sent',
      workflowRunId: message.workflowRunId,
      packageId: message.packageId,
      detail: { recipient: message.recipient, messageId: created.id }
    });
    return created;
  }

  // ---- Private helpers ----------------------------------------------------

  /** Internal: load a package directory into memory without touching the registry file. */
  private loadPackageInternal(
    packageDir: string,
    signing?: LoadedPackageEntry['signing']
  ): PackageSummary {
    const pkg = loadWorkforcePackage(packageDir);
    const compat = checkEngineCompatibility(pkg.manifest.engineVersion, ENGINE_VERSION);
    if (!compat.compatible) {
      throw new Error(
        `Package '${pkg.manifest.id}' is not compatible with engine ${ENGINE_VERSION}: ${compat.reason}`
      );
    }
    const models = this.buildModelRegistry();
    const memory = new MemoryService();
    const engine = new WorkflowEngine(
      new AgentRuntime(pkg, models, memory, this.audit),
      this.audit,
      this.stateStore
    );
    this.loadedPackages.set(pkg.manifest.id, { pkg, engine, signing });
    this.rebuildIdentity();
    return toPackageSummary(pkg, signing);
  }

  private entry(packageId: string): LoadedPackageEntry {
    const entry = this.loadedPackages.get(packageId);
    if (!entry) throw new Error(`Package '${packageId}' is not loaded`);
    return entry;
  }

  private currentPrincipal(): Principal | undefined {
    if (!this.identity || !this.sessionId) return undefined;
    return this.identity.getSession(this.sessionId)?.principal;
  }

  private buildModelRegistry(): ModelRegistry {
    if (!this.hasConfiguredModels && !this.modelRegistry) {
      this.modelConfigWarning = undefined;
      return this.fallbackRegistry();
    }
    if (this.modelRegistry) return this.modelRegistry;
    try {
      this.modelRegistry = resolveModelRegistry(undefined, undefined, this.modelConfig, this.env);
      this.modelConfigWarning = undefined;
      return this.modelRegistry;
    } catch (error) {
      this.modelConfigWarning = error instanceof Error ? error.message : String(error);
      return this.fallbackRegistry();
    }
  }

  private fallbackRegistry(): ModelRegistry {
    return new ModelRegistry()
      .set('small', this.fallbackModelProvider)
      .set('medium', this.fallbackModelProvider)
      .set('large', this.fallbackModelProvider);
  }

  private reloadLoadedPackages(): void {
    const existing = [...this.loadedPackages.values()].map(({ pkg, signing }) => ({ dir: pkg.rootDir, signing }));
    this.loadedPackages.clear();
    for (const entry of existing) {
      this.loadPackageInternal(entry.dir, entry.signing);
    }
  }

  /**
   * Rebuild the identity service over all roles in all loaded packages. With a
   * deployment identity config the configured OIDC providers and role mappings
   * are preserved and the dev mock provider is always available for quick
   * role-based sign-in during development.
   */
  private rebuildIdentity(): void {
    const roles = new Set<string>();
    for (const { pkg } of this.loadedPackages.values()) {
      for (const workflow of pkg.workflows.values()) {
        for (const role of humanRoles(workflow)) roles.add(role);
      }
    }
    const config: IdentityConfig = {
      providers: [
        ...(this.identityConfig?.providers ?? []),
        ...(this.identityConfig?.providers.some((p) => p.id === 'dev')
          ? []
          : [{ id: 'dev' as const, type: 'mock' as const }])
      ],
      roleMappings: [
        ...(this.identityConfig?.roleMappings ?? []),
        ...[...roles].map((role) => ({ claim: 'role', value: role, role }))
      ]
    };
    const service = IdentityService.fromConfig(config, this.audit);
    const provider = service.registry.get('dev') as MockIdentityProvider | undefined;
    if (provider) {
      for (const role of roles) {
        provider.addUser(`dev-${role}`, { sub: `dev-${role}`, name: `Dev ${role}`, role });
      }
    }
    this.identity = service;
    this.sessionId = undefined;
  }

  // ---- Persistence --------------------------------------------------------

  private dataFilePath(name: string): string {
    if (!this.dataDir) throw new Error('dataFilePath called without a dataDir configured');
    return join(this.dataDir, name);
  }

  private readJsonFile<T>(name: string, fallback: T): T {
    const path = this.dataFilePath(name);
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private writeJsonFile(name: string, value: unknown): void {
    writeFileSync(this.dataFilePath(name), JSON.stringify(value, null, 2), 'utf8');
  }

  private savePackageRegistry(): void {
    const registry: Record<string, { dir: string; signing?: LoadedPackageEntry['signing'] }> = {};
    for (const { pkg, signing } of this.loadedPackages.values()) {
      registry[pkg.manifest.id] = { dir: pkg.rootDir, ...(signing ? { signing } : {}) };
    }
    this.writeJsonFile('packages.json', registry);
  }

  private saveRunIndex(): void {
    this.writeJsonFile('run-index.json', Object.fromEntries(this.runIndex));
  }
}

// Re-export API types for consumers that import from this package.
export type {
  AgentSummary,
  AuditFilter,
  AuditTrailSnapshot,
  GovernanceSummary,
  HumanResponse,
  IdentityProviderSummary,
  KernelApi,
  PackageSummary,
  PackageValidationResult,
  PendingTaskSnapshot,
  RunSnapshot,
  SkillSummary,
  TokenSetLike,
  UserSnapshot,
  WorkflowSummary,
} from './api.js';
export {
  assertNoSecrets,
  defaultConfig,
  loadConfig,
  readConfigFile,
  repoConfigPath,
  resolveModelRegistry,
  saveConfig,
  userConfigPath,
  validateConfig
} from './config.js';
export type {
  CloudProviderConfig,
  DeepPartial,
  FlowForgeConfig,
  HybridMapping,
  ModelConfigSnapshot,
  OllamaProviderConfig,
  ProviderType,
  TierSpec
} from './config.js';
export {
  InMemoryMessagingTransport,
} from './messaging.js';
export type {
  MessageFilter,
  MessageRecipient,
  MessageRecord,
  MessagingTransport,
  SendMessageInput
} from './messaging.js';
