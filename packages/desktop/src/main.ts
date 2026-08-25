/**
 * Electron main process (Tasks 2.1.1, 2.1.3, 2.1.4; Phase 5.1). Hosts the
 * kernel and exposes it over IPC. The renderer is treated as untrusted web
 * content: nodeIntegration is off, contextIsolation and sandbox are on, and
 * only the allow-listed preload API can reach this process.
 *
 * The main process also performs the OIDC authorization-code + PKCE dance
 * (I.6): it opens the provider's authorize URL in the system browser, waits on
 * a loopback redirect, exchanges the code and signs the kernel in. Tokens
 * never cross the IPC bridge — the renderer only ever sees a UserSnapshot.
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { DesktopKernel } from './kernel.js';
import { IpcChannels, type HumanResponse } from './ipc.js';
import { loadIdentityConfig } from './oidc.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Perform an OIDC authorization-code + PKCE login for a provider. Returns the
 * resulting UserSnapshot to the renderer; tokens stay in the main process.
 */
async function oidcLogin(kernel: DesktopKernel, providerId: string): Promise<import('@flowforge/kernel').UserSnapshot> {
  const { redirectUri, server } = await startRedirectServer();
  try {
    const { url, state, codeVerifier } = await kernel.beginOidcLogin(providerId, redirectUri);
    await shell.openExternal(url);
    const code = await waitForCode(server, state);
    return await kernel.completeOidcLogin(providerId, code, codeVerifier, redirectUri);
  } finally {
    server.close();
  }
}

/** Start a loopback HTTP server that captures the OIDC redirect. */
function startRedirectServer(): Promise<{ redirectUri: string; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No loopback address'));
      resolve({ redirectUri: `http://127.0.0.1:${address.port}/callback`, server });
    });
  });
}

/** Wait for the redirect with `?code=...&state=...`, rejecting on a state mismatch. */
function waitForCode(
  server: ReturnType<typeof createServer>,
  expectedState: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OIDC login timed out')), 120_000);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || state !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Login failed: invalid or mismatched authorization response');
        return;
      }
      clearTimeout(timer);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>FlowForge</title><p>You are signed in. Close this tab.</p>');
      resolve(code);
    });
  });
}

export function registerIpcHandlers(kernel: DesktopKernel): void {
  ipcMain.handle(IpcChannels.validatePackage, (_event, packageDir: string) =>
    kernel.validatePackage(packageDir)
  );
  ipcMain.handle(IpcChannels.loadPackage, (_event, packageDir: string) => kernel.loadPackage(packageDir));
  ipcMain.handle(IpcChannels.listPackages, () => kernel.listPackages());
  ipcMain.handle(IpcChannels.removePackage, (_event, packageId: string) => kernel.removePackage(packageId));
  ipcMain.handle(IpcChannels.selectPackage, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a workforce package',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Workforce packages', extensions: ['workforce'] }]
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle(IpcChannels.installWorkflowArchive, (_event, archivePath: string) =>
    kernel.installWorkforceArchive(archivePath)
  );
  ipcMain.handle(IpcChannels.getWorkflow, (_event, packageId: string, workflowId: string) =>
    kernel.getWorkflow(packageId, workflowId)
  );
  ipcMain.handle(IpcChannels.startRun, (_event, packageId: string, workflowId: string) =>
    kernel.startRun(packageId, workflowId)
  );
  ipcMain.handle(IpcChannels.resumeRun, (_event, runId: string, response: HumanResponse) =>
    kernel.resumeRun(runId, response)
  );
  ipcMain.handle(IpcChannels.listRuns, (_event, packageId?: string) => kernel.listRuns(packageId));
  ipcMain.handle(IpcChannels.getRun, (_event, runId: string) => kernel.getRun(runId));
  ipcMain.handle(IpcChannels.getAuditTrail, (_event, runId?: string) =>
    kernel.getAuditTrail(runId ? { runId } : undefined)
  );
  ipcMain.handle(IpcChannels.signIn, (_event, role: string) => kernel.signIn(role));
  ipcMain.handle(IpcChannels.signInWithOidc, (_event, providerId: string) =>
    oidcLogin(kernel, providerId)
  );
  ipcMain.handle(IpcChannels.listIdentityProviders, () => kernel.listIdentityProviders());
  ipcMain.handle(IpcChannels.getGovernance, () => kernel.getGovernance());
  ipcMain.handle(IpcChannels.signOut, () => kernel.signOut());
  ipcMain.handle(IpcChannels.getCurrentUser, () => kernel.getCurrentUser());
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'FlowForge',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  const identity = loadIdentityConfig();
  registerIpcHandlers(new DesktopKernel({ dataDir: process.env.FLOWFORGE_DATA_DIR, ...(identity ? { identity } : {}) }));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
