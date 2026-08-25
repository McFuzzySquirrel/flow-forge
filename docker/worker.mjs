/**
 * Hosted Dapr worker entrypoint (Phase 4.3.4).
 *
 * Loads a .workforce package, wires the shared dependencies, registers the
 * declarative workflows on a Dapr WorkflowRuntime and serves them. Run inside
 * the compose stack where the Dapr sidecar is reachable via the DAPR_* env
 * vars the daprd sidecar injects.
 *
 *   node packages/dapr-runner/dist/...    (or via docker compose)
 */
import { DaprClient, WorkflowRuntime } from '@dapr/dapr';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';
import { AuditLog, FileAuditSink } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { registerDaprWorkflows } from '@flowforge/dapr-runner';
import { DaprStateStoreAdapter } from '@flowforge/dapr-runner';

const packageDir = process.argv[2] ?? '/workforce';
const dataDir = process.env.FLOWFORGE_DATA_DIR ?? '/data';

const pkg = loadWorkforcePackage(packageDir);
const models = new ModelRegistry()
  .set('small', new MockModelProvider(() => JSON.stringify({ note: 'mock response' })))
  .set('medium', new MockModelProvider(() => JSON.stringify({ note: 'mock response' })))
  .set('large', new MockModelProvider(() => JSON.stringify({ note: 'mock response' })));
const audit = new AuditLog(new FileAuditSink(`${dataDir}/audit.jsonl`));

// Run snapshots persist to the Dapr state store (Redis) so the client side can
// query them from any process. Swap the store here to change persistence.
const daprClient = new DaprClient();
const runStore = new DaprStateStoreAdapter(daprClient);

const agents = new AgentRuntime(pkg, models, new MemoryService(), audit);
const runtime = new WorkflowRuntime();

const counts = registerDaprWorkflows(runtime, [...pkg.workflows.values()], {
  runStore,
  agents,
  audit
});
console.log(
  `[flowforge-worker] registered ${counts.workflows} workflows, ${counts.activities} activities ` +
    `for ${pkg.manifest.id} v${pkg.manifest.version}`
);

await runtime.start();
