import type { FlowForgeApi } from '../../src/ipc.js';

declare global {
  interface Window {
    /** Allow-listed kernel API exposed by the preload's contextBridge. */
    flowforge: FlowForgeApi;
  }
}

export {};
