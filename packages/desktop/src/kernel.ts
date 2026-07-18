/**
 * DesktopKernel — the kernel bridge for the Electron main process (Task 2.1.3).
 *
 * Since ADR-0011, all kernel logic lives in @flowforge/kernel (FlowForgeKernel).
 * This file re-exports FlowForgeKernel as DesktopKernel so main.ts and its
 * tests require no changes.  The snapshot types it previously defined have
 * moved to @flowforge/kernel/src/api.ts and are re-exported from ipc.ts for
 * backward compatibility with the preload / renderer type imports.
 */
export { FlowForgeKernel as DesktopKernel } from '@flowforge/kernel';
