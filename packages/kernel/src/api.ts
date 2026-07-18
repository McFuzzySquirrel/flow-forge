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
import type { AuditRecord } from '@flowforge/core';

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface PackageValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  modelTier: string;
  skills: string[];
  defaultPersona?: string;
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
  workflows: WorkflowSummary[];
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
  error?: string;
}

/** The signed-in user as seen by callers — never tokens or sessions. */
export interface UserSnapshot {
  id: string;
  displayName?: string;
  provider: string;
  roles: string[];
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
   * process restart.
   */
  loadPackage(packageDir: string): PackageSummary;

  /** List all loaded / installed packages. */
  listPackages(): PackageSummary[];

  /** Unload a package and remove it from the persistent registry. */
  removePackage(packageId: string): void;

  // ---- Runs ---------------------------------------------------------------

  /** Start a new workflow run.  Returns the run immediately; it may already
   *  be waitingForHuman if the first node is a human step. */
  startRun(packageId: string, workflowId: string): Promise<RunSnapshot>;

  /**
   * Resume a paused run with a human response.  The caller must be signed in
   * (ADR-0010); the engine enforces role and participant-binding checks.
   */
  resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot>;

  /** List runs, optionally filtered to a single package. */
  listRuns(packageId?: string): RunSnapshot[];

  /** Get a single run by id. */
  getRun(runId: string): Promise<RunSnapshot | undefined>;

  // ---- Audit --------------------------------------------------------------

  /** Return audit records, optionally filtered. */
  getAuditTrail(filter?: AuditFilter): AuditTrailSnapshot;

  // ---- Identity -----------------------------------------------------------

  /**
   * Sign in using the dev identity provider (one mock user per role).
   * OIDC authorization-code + PKCE replaces this when a deployment identity
   * config is supplied (I.6, deferred to Phase 5 — ADR-0011).
   */
  signIn(role: string): Promise<UserSnapshot>;

  signOut(): void;

  getCurrentUser(): UserSnapshot | undefined;
}
