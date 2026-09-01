/**
 * Transport-agnostic Kernel API contract (ADR-0011).
 *
 * All types are JSON-serializable so this contract survives any transport layer
 * (Electron IPC, HTTP, Unix socket, direct function call).  Every UI surface —
 * Electron, mobile, web — and the CLI consume exactly this interface.  The
 * FlowForgeKernel class is the reference implementation; a transport adapter
 * (e.g. the Electron main-process IPC wrapper) is a thin mapping from its
 * channel protocol to these method signatures.
 *
 * Snapshot types are plain records with no methods, no circular refs, and no
 * class instances.  They survive JSON round-trips and Electron structuredClone.
 */
import type { AuditRecord, WorkflowDefinition } from '@flowforge/core';
import type { ModelConfigSnapshot } from './config.js';
import type { MessageFilter, MessageRecord, SendMessageInput } from './messaging.js';

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface PackageValidationResult {
  valid: boolean;
  errors: string[];
  graphErrors: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  modelTier: string;
  skills: string[];
  defaultPersona?: string;
}

export interface SkillSummary {
  id: string;
  displayName?: string;
  description: string;
}

export interface WorkflowSummary {
  id: string;
  description?: string;
  nodeCount: number;
  /** Human roles referenced by humanInput/humanApproval nodes. */
  roles: string[];
}

export interface PackageSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Absolute directory from which the package was loaded. */
  dir: string;
  agents: AgentSummary[];
  skills: SkillSummary[];
  workflows: WorkflowSummary[];
  /** Package branding for the home screen. */
  branding?: { displayName?: string; primaryColor?: string; icon?: string };
  /** Provenance recorded at install time (Phase 4). Undefined when unknown. */
  signing?: {
    signed: boolean;
    signerFingerprint?: string;
    publisher?: string;
  };
}

export interface PendingTaskSnapshot {
  nodeId: string;
  kind: 'input' | 'approval';
  role: string;
  prompt?: string;
  subject?: unknown;
}

export interface RunSnapshot {
  id: string;
  packageId: string;
  workflowId: string;
  status: 'running' | 'waitingForHuman' | 'completed' | 'failed';
  currentNodeId?: string;
  pending?: PendingTaskSnapshot;
  /** Per-run participant bindings: role → principal id (ADR-0010). */
  participants?: Record<string, string>;
  runPersonaId?: string;
  error?: string;
}

/** The signed-in user as seen by callers — never tokens or sessions. */
export interface UserSnapshot {
  id: string;
  displayName?: string;
  provider: string;
  roles: string[];
}

/** A configured identity provider surfaced to UIs (never exposes secrets). */
export interface IdentityProviderSummary {
  id: string;
  displayName?: string;
  type: 'oidc' | 'mock';
}

/** Per-user governance summary for the admin view (I.8). */
export interface UserAuditSummary {
  actorId: string;
  provider?: string;
  roles: string[];
  recordCount: number;
  lastAction?: string;
}

/** Read-only governance snapshot (5.1.8). */
export interface GovernanceSummary {
  providers: IdentityProviderSummary[];
  roleMappings: Array<{ claim: string; value: string; role: string }>;
  permissions: Record<string, string[]>;
  session: { ttlSeconds?: number };
  userAudit: UserAuditSummary[];
}

/** Tokens produced by an identity provider flow (IPC-only, never persisted). */
export interface TokenSetLike {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface HumanResponse {
  value?: unknown;
  approved?: boolean;
  reason?: string;
}

export interface AuditTrailSnapshot {
  records: AuditRecord[];
  /** Result of recomputing the hash chain over the full log. */
  chainIntact: boolean;
}

/** Filter options for audit queries. */
export interface AuditFilter {
  /** Only records for this run. */
  runId?: string;
  /** Only records for any of these runs. */
  runIds?: string[];
  /** Only records whose actor.id matches. */
  actor?: string;
  /** Only records whose action string matches (exact). */
  action?: string;
}

// ---------------------------------------------------------------------------
// KernelApi interface
// ---------------------------------------------------------------------------

/**
 * The single, transport-agnostic interface every surface consumes.
 * Synchronous methods never touch the network or filesystem in a
 * latency-sensitive way; async methods may.
 */
export interface KernelApi {
  // ---- Packages -----------------------------------------------------------

  /** Validate a .workforce package directory without loading it. */
  validatePackage(packageDir: string): PackageValidationResult;

  /**
   * Validate and load a package into this kernel instance.  Persists the
   * package to the data directory (if one is configured) so it survives
   * process restart.  A package whose declared `engineVersion` range the
   * running engine does not satisfy is refused (Phase 4.1.5).
   */
  loadPackage(packageDir: string): PackageSummary;

  /**
   * Install a package from a `.workforce` archive: verify integrity and
   * signature, unpack into the data directory, then load it.  Refuses
   * tampered or engine-incompatible packages; unsigned archives install
   * with a warning flag on the summary.
   */
  installWorkforceArchive(archivePath: string): PackageSummary;

  /** List all loaded / installed packages. */
  listPackages(): PackageSummary[];

  /** Unload a package and remove it from the persistent registry. */
  removePackage(packageId: string): void;

  // ---- Runs ---------------------------------------------------------------

  /** Start a new workflow run.  Returns the run immediately; it may already
   *  be waitingForHuman if the first node is a human step. */
  startRun(packageId: string, workflowId: string, options?: { personaId?: string }): Promise<RunSnapshot>;

  /**
   * Resume a paused run with a human response.  The caller must be signed in
   * (ADR-0010); the engine enforces role and participant-binding checks.
   */
  resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot>;

  /** List runs, optionally filtered to a single package. */
  listRuns(packageId?: string): RunSnapshot[];

  /** Get a single run by id. */
  getRun(runId: string): Promise<RunSnapshot | undefined>;

  /**
   * Import an externally-executed run (e.g. one driven by the CLI's own
   * engine) plus its audit records into this kernel's persistence, so
   * `runs list`/`audit show` reflect headless CLI runs too.
   */
  importRun(packageDir: string, run: import('@flowforge/workflow').WorkflowRun, auditRecords: AuditRecord[]): RunSnapshot;

  // ---- Audit --------------------------------------------------------------

  /** Return audit records, optionally filtered. */
  getAuditTrail(filter?: AuditFilter): AuditTrailSnapshot;

  // ---- Workflows (read-only graph access for editors / viewers) -----------

  /** Get a loaded workflow's full definition (the visual editor renders this). */
  getWorkflow(packageId: string, workflowId: string): WorkflowDefinition;
  saveWorkflow(packageId: string, workflow: WorkflowDefinition): WorkflowSummary;
  updateAgentSkills(packageId: string, agentId: string, skills: string[]): AgentSummary;

  // ---- Model configuration -------------------------------------------------

  getModelConfig(): ModelConfigSnapshot;
  updateModelConfig(config: ModelConfigSnapshot): ModelConfigSnapshot;

  // ---- Identity -----------------------------------------------------------

  /** Configured identity providers (mock + any deployment OIDC providers). */
  listIdentityProviders(): IdentityProviderSummary[];

  /** Read-only governance snapshot: providers, role mappings, per-user audit. */
  getGovernance(): GovernanceSummary;

  /**
   * Sign in using the dev identity provider (one mock user per role).
   * OIDC authorization-code + PKCE replaces this when a deployment identity
   * config is supplied (I.6).
   */
  signIn(role: string): Promise<UserSnapshot>;

  /**
   * Sign in with tokens from an OIDC authorization-code + PKCE flow. The
   * transport adapter (e.g. the Electron main process) performs the browser +
   * loopback-redirect dance and hands the exchanged tokens to the kernel; the
   * kernel is the authorization authority (ADR-0010).
   */
  signInWithTokens(providerId: string, tokens: TokenSetLike): Promise<UserSnapshot>;

  /**
   * Begin an OIDC authorization-code + PKCE flow (I.6). Returns the
   * authorization URL to open in a browser plus the state/PKCE verifier the
   * adapter must hand back to {@link completeOidcLogin} after the redirect.
   */
  beginOidcLogin(providerId: string, redirectUri: string): Promise<{ url: string; state: string; codeVerifier: string }>;

  /** Complete an OIDC authorization-code + PKCE flow with the callback's code. */
  completeOidcLogin(
    providerId: string,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<UserSnapshot>;

  signOut(): void;

  getCurrentUser(): UserSnapshot | undefined;

  // ---- Messaging -----------------------------------------------------------

  listMessages(filter?: MessageFilter): Promise<MessageRecord[]>;
  sendMessage(message: SendMessageInput): Promise<MessageRecord>;
}
