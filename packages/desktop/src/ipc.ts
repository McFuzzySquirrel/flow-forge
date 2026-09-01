/**
 * Typed IPC contract shared between the Electron main process and the
 * renderer (Tasks 2.1.2, 5.1.x). Snapshot types live in @flowforge/kernel so
 * they can be shared with the CLI and any future transport adapter. This file
 * re-exports those types and adds the Electron-specific channel names and the
 * renderer-facing async FlowForgeApi.
 */

/** Channel names — the preload and main process must agree on these. */
export const IpcChannels = {
  validatePackage: 'flowforge:validate-package',
  loadPackage: 'flowforge:load-package',
  listPackages: 'flowforge:list-packages',
  removePackage: 'flowforge:remove-package',
  selectPackage: 'flowforge:select-package',
  installPackage: 'flowforge:install-package',
  installWorkflowArchive: 'flowforge:install-workflow-archive',
  getWorkflow: 'flowforge:get-workflow',
  saveWorkflow: 'flowforge:save-workflow',
  updateAgentSkills: 'flowforge:update-agent-skills',
  startRun: 'flowforge:start-run',
  resumeRun: 'flowforge:resume-run',
  listRuns: 'flowforge:list-runs',
  getRun: 'flowforge:get-run',
  getAuditTrail: 'flowforge:get-audit-trail',
  getModelConfig: 'flowforge:get-model-config',
  updateModelConfig: 'flowforge:update-model-config',
  listMessages: 'flowforge:list-messages',
  sendMessage: 'flowforge:send-message',
  signIn: 'flowforge:sign-in',
  signInWithOidc: 'flowforge:sign-in-with-oidc',
  listIdentityProviders: 'flowforge:list-identity-providers',
  getGovernance: 'flowforge:get-governance',
  signOut: 'flowforge:sign-out',
  getCurrentUser: 'flowforge:get-current-user'
} as const;

// Re-export shared snapshot types from the kernel package.
export type {
  AgentSummary,
  AuditTrailSnapshot,
  GovernanceSummary,
  HumanResponse,
  IdentityProviderSummary,
  MessageFilter,
  MessageRecord,
  ModelConfigSnapshot,
  PackageSummary,
  PackageValidationResult,
  PendingTaskSnapshot,
  RunSnapshot,
  SendMessageInput,
  SkillSummary,
  UserSnapshot,
  WorkflowSummary
} from '@flowforge/kernel';

import type {
  AgentSummary,
  AuditTrailSnapshot,
  GovernanceSummary,
  HumanResponse,
  IdentityProviderSummary,
  MessageFilter,
  MessageRecord,
  ModelConfigSnapshot,
  PackageSummary,
  PackageValidationResult,
  RunSnapshot,
  SendMessageInput,
  UserSnapshot,
  WorkflowSummary
} from '@flowforge/kernel';
import type { WorkflowDefinition } from '@flowforge/core';

/**
 * The renderer-facing, fully-async API surface exposed via contextBridge.
 * Methods that accept filters (e.g. getAuditTrail) keep a simple runId
 * parameter for renderer use; the kernel's richer AuditFilter type is
 * available to the main process directly.
 */
export interface FlowForgeApi {
  // ---- Packages -----------------------------------------------------------

  validatePackage(packageDir: string): Promise<PackageValidationResult>;
  loadPackage(packageDir: string): Promise<PackageSummary>;
  listPackages(): Promise<PackageSummary[]>;
  removePackage(packageId: string): Promise<void>;
  /**
   * Open a native picker (main-process `dialog`) to choose a `.workforce`
   * directory or archive. Resolves undefined if the user cancels.
   */
  selectPackagePath(): Promise<string | undefined>;
  /**
   * Install a package by path. The main process distinguishes a package
   * directory (validate + load) from a `.workforce` archive file (verify
   * integrity + signature, unpack, load), so a directory whose name ends in
   * `.workforce` is handled correctly.
   */
  installPackage(
    packagePath: string
  ): Promise<{ ok: true; summary: PackageSummary } | { ok: false; validation: PackageValidationResult }>;
  /** Install from a `.workforce` archive: verifies integrity + signature first. */
  installWorkflowArchive(archivePath: string): Promise<PackageSummary>;

  // ---- Workflows (read-only graph access for the editor) -------------------

  getWorkflow(packageId: string, workflowId: string): Promise<WorkflowDefinition>;
  saveWorkflow(packageId: string, workflow: WorkflowDefinition): Promise<WorkflowSummary>;
  updateAgentSkills(packageId: string, agentId: string, skills: string[]): Promise<AgentSummary>;

  // ---- Runs ----------------------------------------------------------------

  startRun(packageId: string, workflowId: string, options?: { personaId?: string }): Promise<RunSnapshot>;
  resumeRun(runId: string, response: HumanResponse): Promise<RunSnapshot>;
  listRuns(packageId?: string): Promise<RunSnapshot[]>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;

  // ---- Audit ---------------------------------------------------------------

  getAuditTrail(runId?: string): Promise<AuditTrailSnapshot>;
  getModelConfig(): Promise<ModelConfigSnapshot>;
  updateModelConfig(config: ModelConfigSnapshot): Promise<ModelConfigSnapshot>;

  // ---- Identity ------------------------------------------------------------

  /**
   * Sign in as one of the loaded package's workflow roles using the dev
   * identity provider (one user per role).
   */
  signIn(role: string): Promise<UserSnapshot>;
  /**
   * Sign in via an OIDC provider using authorization-code + PKCE (I.6). The
   * main process opens the provider's authorize URL in the system browser,
   * waits on a loopback redirect and exchanges the code. Tokens never cross
   * the IPC bridge.
   */
  signInWithOidc(providerId: string): Promise<UserSnapshot>;
  listIdentityProviders(): Promise<IdentityProviderSummary[]>;
  getGovernance(): Promise<GovernanceSummary>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<UserSnapshot | undefined>;

  // ---- Messaging -----------------------------------------------------------

  listMessages(filter?: MessageFilter): Promise<MessageRecord[]>;
  sendMessage(message: SendMessageInput): Promise<MessageRecord>;
}
