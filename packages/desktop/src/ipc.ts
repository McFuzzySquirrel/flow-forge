/**
 * Typed IPC contract shared between the Electron main process and the
 * renderer (Task 2.1.2). Snapshot types now live in @flowforge/kernel so
 * they can be shared with the CLI and any future transport adapter.
 * This file re-exports those types and adds the Electron-specific channel
 * names and the renderer-facing async FlowForgeApi.
 */

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

// Re-export shared snapshot types from the kernel package.
export type {
  AgentSummary,
  AuditTrailSnapshot,
  HumanResponse,
  PackageSummary,
  PackageValidationResult,
  PendingTaskSnapshot,
  RunSnapshot,
  UserSnapshot,
  WorkflowSummary
} from '@flowforge/kernel';

/**
 * The renderer-facing, fully-async API surface exposed via contextBridge.
 * Methods that accept filters (e.g. getAuditTrail) keep a simple runId
 * parameter for renderer use; the kernel's richer AuditFilter type is
 * available to the main process directly.
 */
import type {
  AuditTrailSnapshot,
  HumanResponse,
  PackageSummary,
  PackageValidationResult,
  RunSnapshot,
  UserSnapshot
} from '@flowforge/kernel';

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
   * replaces this when a deployment identity config is supplied (I.6,
   * deferred to Phase 5 — ADR-0011).
   */
  signIn(role: string): Promise<UserSnapshot>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<UserSnapshot | undefined>;
}
