/**
 * Electron main process (Tasks 2.1.1, 2.1.3, 2.1.4). Hosts the kernel and
 * exposes it over IPC. The renderer is treated as untrusted web content:
 * nodeIntegration is off, contextIsolation and sandbox are on, and only the
 * allow-listed preload API can reach this process.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { DesktopKernel } from './kernel.js';
import { IpcChannels, type HumanResponse } from './ipc.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerIpcHandlers(kernel: DesktopKernel): void {
  ipcMain.handle(IpcChannels.validatePackage, (_event, packageDir: string) =>
    kernel.validatePackage(packageDir)
  );
  ipcMain.handle(IpcChannels.loadPackage, (_event, packageDir: string) => kernel.loadPackage(packageDir));
  ipcMain.handle(IpcChannels.startRun, (_event, packageId: string, workflowId: string) =>
    kernel.startRun(packageId, workflowId)
  );
  ipcMain.handle(IpcChannels.resumeRun, (_event, runId: string, response: HumanResponse) =>
    kernel.resumeRun(runId, response)
  );
  ipcMain.handle(IpcChannels.getRun, (_event, runId: string) => kernel.getRun(runId));
  ipcMain.handle(IpcChannels.getAuditTrail, (_event, runId?: string) => kernel.getAuditTrail(runId));
  ipcMain.handle(IpcChannels.signIn, (_event, role: string) => kernel.signIn(role));
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
  registerIpcHandlers(new DesktopKernel());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
