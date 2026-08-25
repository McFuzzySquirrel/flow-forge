/**
 * Run-state adapters (Phase 4.3.3). The workflow orchestrator persists each run
 * snapshot through the same {@link RunStore} the client reads, so both sides
 * agree on run state. The Dapr adapter stores snapshots as JSON in a Dapr
 * state store (Redis-backed in the compose stack).
 */
import type { WorkflowRun } from '@flowforge/workflow';
import { InMemoryRunStore, type DaprStateClientLike, type RunStore } from './types.js';

/** Stores run snapshots in a Dapr state store (statestore component). */
export class DaprStateStoreAdapter implements RunStore {
  constructor(
    private readonly client: DaprStateClientLike,
    private readonly storeName = 'statestore'
  ) {}

  private key(runId: string): string {
    return `flowforge:run:${runId}`;
  }

  async save(run: WorkflowRun): Promise<void> {
    await this.client.state.save(this.storeName, [{ key: this.key(run.id), value: JSON.stringify(run) }]);
  }

  async load(runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.client.state.get(this.storeName, this.key(runId));
    return result?.data ? (JSON.parse(result.data) as WorkflowRun) : undefined;
  }
}

export { InMemoryRunStore, type RunStore };
