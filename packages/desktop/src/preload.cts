/**
 * Preload script (Tasks 2.1.4, 5.1.x). Runs in the renderer's isolated world
 * and exposes a minimal, allow-listed API via contextBridge — the renderer
 * never gets ipcRenderer, Node or Electron internals. Compiled to CommonJS
 * (preload.cjs) because sandboxed preloads must be CJS.
 *
 * Channel strings are literals here (a sandboxed CJS preload cannot import
 * the ESM contract module), but `satisfies FlowForgeApi` keeps this file
 * type-checked against the shared contract in ipc.ts.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { FlowForgeApi, HumanResponse } from './ipc.js';

/** Compile-time guard: these literals must match the shared IpcChannels. */
const channels: typeof import('./ipc.js').IpcChannels = {
  validatePackage: 'flowforge:validate-package',
  loadPackage: 'flowforge:load-package',
  listPackages: 'flowforge:list-packages',
  removePackage: 'flowforge:remove-package',
  installWorkflowArchive: 'flowforge:install-workflow-archive',
  getWorkflow: 'flowforge:get-workflow',
  startRun: 'flowforge:start-run',
  resumeRun: 'flowforge:resume-run',
  listRuns: 'flowforge:list-runs',
  getRun: 'flowforge:get-run',
  getAuditTrail: 'flowforge:get-audit-trail',
  signIn: 'flowforge:sign-in',
  signInWithOidc: 'flowforge:sign-in-with-oidc',
  listIdentityProviders: 'flowforge:list-identity-providers',
  getGovernance: 'flowforge:get-governance',
  signOut: 'flowforge:sign-out',
  getCurrentUser: 'flowforge:get-current-user'
};

const api = {
  validatePackage: (packageDir: string) => ipcRenderer.invoke(channels.validatePackage, packageDir),
  loadPackage: (packageDir: string) => ipcRenderer.invoke(channels.loadPackage, packageDir),
  listPackages: () => ipcRenderer.invoke(channels.listPackages),
  removePackage: (packageId: string) => ipcRenderer.invoke(channels.removePackage, packageId),
  installWorkflowArchive: (archivePath: string) =>
    ipcRenderer.invoke(channels.installWorkflowArchive, archivePath),
  getWorkflow: (packageId: string, workflowId: string) =>
    ipcRenderer.invoke(channels.getWorkflow, packageId, workflowId),
  startRun: (packageId: string, workflowId: string) =>
    ipcRenderer.invoke(channels.startRun, packageId, workflowId),
  resumeRun: (runId: string, response: HumanResponse) =>
    ipcRenderer.invoke(channels.resumeRun, runId, response),
  listRuns: (packageId?: string) => ipcRenderer.invoke(channels.listRuns, packageId),
  getRun: (runId: string) => ipcRenderer.invoke(channels.getRun, runId),
  getAuditTrail: (runId?: string) => ipcRenderer.invoke(channels.getAuditTrail, runId),
  signIn: (role: string) => ipcRenderer.invoke(channels.signIn, role),
  signInWithOidc: (providerId: string) => ipcRenderer.invoke(channels.signInWithOidc, providerId),
  listIdentityProviders: () => ipcRenderer.invoke(channels.listIdentityProviders),
  getGovernance: () => ipcRenderer.invoke(channels.getGovernance),
  signOut: () => ipcRenderer.invoke(channels.signOut),
  getCurrentUser: () => ipcRenderer.invoke(channels.getCurrentUser)
} satisfies FlowForgeApi;

contextBridge.exposeInMainWorld('flowforge', api);
