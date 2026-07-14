/**
 * Preload script (Task 2.1.4). Runs in the renderer's isolated world and
 * exposes a minimal, allow-listed API via contextBridge — the renderer never
 * gets ipcRenderer, Node or Electron internals. Compiled to CommonJS
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
  startRun: 'flowforge:start-run',
  resumeRun: 'flowforge:resume-run',
  getRun: 'flowforge:get-run',
  getAuditTrail: 'flowforge:get-audit-trail',
  signIn: 'flowforge:sign-in',
  signOut: 'flowforge:sign-out',
  getCurrentUser: 'flowforge:get-current-user'
};

const api = {
  validatePackage: (packageDir: string) => ipcRenderer.invoke(channels.validatePackage, packageDir),
  loadPackage: (packageDir: string) => ipcRenderer.invoke(channels.loadPackage, packageDir),
  startRun: (packageId: string, workflowId: string) =>
    ipcRenderer.invoke(channels.startRun, packageId, workflowId),
  resumeRun: (runId: string, response: HumanResponse) =>
    ipcRenderer.invoke(channels.resumeRun, runId, response),
  getRun: (runId: string) => ipcRenderer.invoke(channels.getRun, runId),
  getAuditTrail: (runId?: string) => ipcRenderer.invoke(channels.getAuditTrail, runId),
  signIn: (role: string) => ipcRenderer.invoke(channels.signIn, role),
  signOut: () => ipcRenderer.invoke(channels.signOut),
  getCurrentUser: () => ipcRenderer.invoke(channels.getCurrentUser)
} satisfies FlowForgeApi;

contextBridge.exposeInMainWorld('flowforge', api);
