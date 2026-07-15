/**
 * Typed IPC contract shared between the Electron main process and the
 * renderer (Task 2.1.2). This file is the single source of truth for what
 * crosses the process boundary: only JSON-serializable snapshot types, never
 * kernel objects, tokens or Node APIs. The renderer consumes `FlowForgeApi`
 * through the allow-listed `window.flowforge` bridge exposed by the preload.
 */
import type { AuditRecord } from '@flowforge/core';

/** Channel names — the preload and main process must agree on these. */
export const IpcChannels = {
  validatePackage: 'flowforge:validate-package',
  loadPackage: 'flowforge:load-package',
  startRun: 'flowforge:start-run',
  resumeRun: 'flowforge:resume-run',
  getRun: 'flowforge:get-run',
  getAuditTrail: 'flowforge:get-audit-trail',
  signIn: 'flowforge:sign-in',
  signOut: 'flowforge:sign-out',
  getCurrentUser: 'flowforge:get-current-user'
} as const;

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
  /** Human roles referenced by the workflow's humanInput/humanApproval nodes. */
  roles: string[];
}

export interface PackageSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
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

/** The signed-in user as shown to the renderer — never tokens or sessions. */
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
  /** Result of recomputing the hash chain over the whole log. */
  chainIntact: boolean;
}

/** The full, allow-listed API surface exposed to the renderer. */
export interface FlowForgeApi {
  validatePackage(packageDir: string): Promise<PackageValidationResult>;
  loadPackage(packageDir: string): Promise<PackageSummary>;
  startRun(packageId: string, workflowId: string): Promise<RunSnapshot>;
  resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;
  getAuditTrail(runId?: string): Promise<AuditTrailSnapshot>;
  /**
   * Sign in as one of the loaded package's workflow roles. Uses the dev
   * identity provider (one user per role); OIDC authorization-code + PKCE
   * replaces this when a deployment identity config is supplied (Task 2.1.6 / I.6).
   */
  signIn(role: string): Promise<UserSnapshot>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<UserSnapshot | undefined>;
}
