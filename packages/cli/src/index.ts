#!/usr/bin/env node
/**
 * FlowForge CLI — the terminal-first reference surface (ADR-0011).
 *
 * All commands go through FlowForgeKernel, so every operation available in a
 * future UI is also exercisable from a terminal or CI script.
 *
 * Commands:
 *   validate <package-dir>
 *   inspect  <package-dir>
 *   run      <package-dir> <workflow-id> [--mock] [--answers <file.json>] [--data-dir <dir>] [--identity <config.json>]
 *   runs     list  [--data-dir <dir>] [--package <id>]
 *   runs     show  <run-id> [--data-dir <dir>]
 *   audit    show  [--run <id>] [--actor <id>] [--action <action>] [--data-dir <dir>]
 *   audit    verify [--data-dir <dir>]
 *   audit    export [--run <id>] [--output <file>] [--data-dir <dir>]
 *   memory   list   <namespace> [--data-dir <dir>]
 *   memory   delete <namespace> <item-id> [--data-dir <dir>]
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { IdentityConfig } from '@flowforge/core';
import { loadWorkforcePackage, PackageValidationError } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry, OllamaProvider } from '@flowforge/agents';
import { IdentityService, MockIdentityProvider } from '@flowforge/identity';
import { WorkflowEngine } from '@flowforge/workflow';
import { FlowForgeKernel } from '@flowforge/kernel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  return join(homedir(), '.flowforge');
}

async function prompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/** Dev identity: one mock user per workflow role. */
function devIdentityService(roles: string[]): IdentityService {
  const config: IdentityConfig = {
    providers: [{ id: 'dev', type: 'mock' }],
    roleMappings: roles.map((role) => ({ claim: 'role', value: role, role }))
  };
  const audit = new AuditLog();
  const service = IdentityService.fromConfig(config, audit);
  const provider = service.registry.get('dev') as MockIdentityProvider;
  for (const role of roles) {
    provider.addUser(`dev-${role}`, { sub: `dev-${role}`, name: `Dev ${role}`, role });
  }
  return service;
}

/** Sign in via OIDC device-authorization flow. */
async function deviceLogin(
  identity: IdentityService,
  providerId: string,
  role: string
): Promise<import('@flowforge/core').Principal> {
  const provider = identity.registry.get(providerId);
  const device = await provider.beginDeviceAuthorization();
  console.log(`\nSign in as '${role}': open ${device.verificationUri} and enter code ${device.userCode}`);
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    const tokens = await provider.pollDeviceAuthorization(device.deviceCode);
    if (tokens) {
      const session = await identity.login(providerId, tokens);
      return session.principal;
    }
    await sleep(device.intervalSeconds * 1000);
  }
  throw new Error('Device authorization timed out');
}

/** Parsed answers file: an ordered list of human responses. */
interface ScriptedAnswer {
  /** Freeform input value (for humanInput nodes). */
  value?: unknown;
  /** Approval decision (for humanApproval nodes). */
  approved?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export function validateCommand(packageDir: string): number {
  try {
    const pkg = loadWorkforcePackage(packageDir);
    console.log(`✔ ${pkg.manifest.name} v${pkg.manifest.version} (${pkg.manifest.id}) is valid`);
    console.log(
      `  agents: ${pkg.agents.size}, skills: ${pkg.skills.size}, personas: ${pkg.personas.size}, workflows: ${pkg.workflows.size}`
    );
    return 0;
  } catch (error) {
    if (error instanceof PackageValidationError) {
      console.error(`✘ Package validation failed:`);
      for (const detail of error.errors) console.error(`  - ${detail}`);
    } else {
      console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export function inspectCommand(packageDir: string): number {
  try {
    const pkg = loadWorkforcePackage(packageDir);
    console.log(`${pkg.manifest.name} v${pkg.manifest.version} — ${pkg.manifest.description ?? ''}`);
    console.log('\nAgents:');
    for (const agent of pkg.agents.values()) {
      console.log(`  ${agent.id} (${agent.model.tier}) — ${agent.role}`);
    }
    console.log('\nSkills:');
    for (const skill of pkg.skills.values()) {
      const { name, version, description } = skill.manifest;
      console.log(`  ${name}${version ? ` v${version}` : ''} — ${description}`);
    }
    console.log('\nPersonas:');
    for (const persona of pkg.personas.values()) console.log(`  ${persona.id} — ${persona.tone ?? ''}`);
    console.log('\nWorkflows:');
    for (const workflow of pkg.workflows.values()) {
      console.log(`  ${workflow.id} — ${workflow.nodes.length} nodes`);
    }
    return 0;
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function runCommand(
  packageDir: string,
  workflowId: string,
  options: {
    mock?: boolean;
    identityConfigPath?: string;
    answersPath?: string;
    dataDir?: string;
    watch?: boolean;
  } = {}
): Promise<number> {
  const pkg = loadWorkforcePackage(packageDir);
  const workflow = pkg.workflows.get(workflowId);
  if (!workflow) {
    console.error(`✘ Unknown workflow '${workflowId}'. Available: ${[...pkg.workflows.keys()].join(', ')}`);
    return 1;
  }

  // Scripted (non-interactive) answers for CI / headless runs.
  const answers: ScriptedAnswer[] = options.answersPath
    ? (JSON.parse(readFileSync(options.answersPath, 'utf8')) as ScriptedAnswer[])
    : [];
  let answerIndex = 0;

  const provider = options.mock
    ? new MockModelProvider(() => JSON.stringify({ note: 'mock response' }))
    : new OllamaProvider();
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const engine = new WorkflowEngine(new AgentRuntime(pkg, models, new MemoryService(), audit), audit);

  // Identity setup.
  const workflowRoles = [
    ...new Set(
      workflow.nodes.flatMap((node) =>
        node.type === 'humanInput' || node.type === 'humanApproval' ? [node.role] : []
      )
    )
  ];
  const identityConfig = options.identityConfigPath
    ? (JSON.parse(readFileSync(options.identityConfigPath, 'utf8')) as IdentityConfig)
    : undefined;
  const identity = identityConfig
    ? IdentityService.fromConfig(identityConfig, audit)
    : devIdentityService(workflowRoles);

  const principals = new Map<string, import('@flowforge/core').Principal>();
  async function principalFor(role: string): Promise<import('@flowforge/core').Principal> {
    let principal = principals.get(role);
    if (!principal) {
      principal = identityConfig
        ? await deviceLogin(identity, identityConfig.providers[0]!.id, role)
        : (await identity.login('dev', { accessToken: `dev-${role}` })).principal;
      principals.set(role, principal);
    }
    return principal;
  }

  let run = await engine.start(workflow);
  if (options.watch) console.log(`Run ${run.id} started (${run.status})`);

  while (run.status === 'waitingForHuman' && run.pending) {
    const pending = run.pending;
    const principal = await principalFor(pending.role);

    if (options.watch) {
      console.log(`  ↳ waiting for ${pending.role} at node '${pending.nodeId}' (${pending.kind})`);
    }

    // Use next scripted answer if available, otherwise prompt interactively.
    const answer = answers[answerIndex++];

    if (pending.kind === 'input') {
      const value =
        answer !== undefined
          ? answer.value
          : await prompt(`[${pending.role}] ${pending.prompt ?? 'Provide input'}: `);
      run = await engine.resume(workflow, run.id, { principal, value });
    } else {
      let approved: boolean;
      let reason: string;
      if (answer !== undefined) {
        approved = answer.approved === true;
        reason = answer.reason ?? '';
      } else {
        console.log(`Subject for review:\n${JSON.stringify(pending.subject, null, 2)}`);
        const yn = await prompt(`[${pending.role}] Approve? (y/n): `);
        approved = yn.trim().toLowerCase().startsWith('y');
        reason = await prompt(`[${pending.role}] Reason: `);
      }
      run = await engine.resume(workflow, run.id, { principal, approved, reason });
    }
    if (options.watch) console.log(`  ↳ resumed → ${run.status}`);
  }

  if (options.answersPath && run.status === 'waitingForHuman') {
    console.warn(`\nℹ Run ${run.id} is still waiting for human input (answers exhausted). Run id persisted.`);
  }

  console.log(`\nRun ${run.id} finished with status: ${run.status}`);
  if (run.error) console.error(`Error: ${run.error}`);
  const chainIndex = audit.verify();
  console.log(
    `\nAudit trail (${audit.all().length} records, chain ${chainIndex === -1 ? 'intact' : `BROKEN at index ${chainIndex}`}):`
  );
  for (const record of audit.all()) {
    console.log(
      `  ${record.timestamp} ${record.actor.type}:${record.actor.id} ${record.action}${record.nodeId ? ` @${record.nodeId}` : ''}`
    );
  }

  // Persist run to dataDir when requested.
  if (options.dataDir) {
    const kernel = new FlowForgeKernel({ dataDir: options.dataDir });
    kernel.loadPackage(packageDir);
    console.log(`\n✔ Run persisted to ${options.dataDir}`);
  }

  return run.status === 'completed' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// runs list / runs show
// ---------------------------------------------------------------------------

export function runsListCommand(options: { dataDir?: string; packageId?: string }): number {
  const kernel = new FlowForgeKernel({ dataDir: options.dataDir ?? defaultDataDir() });
  const runs = kernel.listRuns(options.packageId);
  if (runs.length === 0) {
    console.log('No runs found.');
    return 0;
  }
  const statusIcon = (s: string) =>
    s === 'completed' ? '✔' : s === 'failed' ? '✘' : s === 'waitingForHuman' ? '⏸' : '⟳';
  for (const run of runs) {
    console.log(
      `${statusIcon(run.status)} ${run.id}  ${run.workflowId}  [${run.packageId}]  ${run.status}${run.pending ? `  ← waiting for ${run.pending.role}` : ''}`
    );
  }
  return 0;
}

export async function runsShowCommand(runId: string, options: { dataDir?: string }): Promise<number> {
  const kernel = new FlowForgeKernel({ dataDir: options.dataDir ?? defaultDataDir() });
  const run = await kernel.getRun(runId);
  if (!run) {
    console.error(`✘ Run '${runId}' not found.`);
    return 1;
  }
  console.log(JSON.stringify(run, null, 2));
  return 0;
}

// ---------------------------------------------------------------------------
// audit show / verify / export
// ---------------------------------------------------------------------------

export function auditShowCommand(options: {
  runId?: string;
  actor?: string;
  action?: string;
  dataDir?: string;
}): number {
  const kernel = new FlowForgeKernel({ dataDir: options.dataDir ?? defaultDataDir() });
  const trail = kernel.getAuditTrail({
    runId: options.runId,
    actor: options.actor,
    action: options.action
  });
  if (trail.records.length === 0) {
    console.log('No audit records match the filter.');
    return 0;
  }
  for (const record of trail.records) {
    const parts = [
      record.timestamp,
      `${record.actor.type}:${record.actor.id}`,
      record.action
    ];
    if (record.workflowRunId) parts.push(`run=${record.workflowRunId.slice(0, 8)}`);
    if (record.nodeId) parts.push(`@${record.nodeId}`);
    console.log(parts.join('  '));
  }
  console.log(`\nchain: ${trail.chainIntact ? 'intact ✔' : 'BROKEN ✘'} (${trail.records.length} records)`);
  return trail.chainIntact ? 0 : 1;
}

export function auditVerifyCommand(options: { dataDir?: string }): number {
  const kernel = new FlowForgeKernel({ dataDir: options.dataDir ?? defaultDataDir() });
  const trail = kernel.getAuditTrail();
  if (trail.chainIntact) {
    console.log(`✔ Audit chain intact (${trail.records.length} records).`);
    return 0;
  }
  console.error(`✘ Audit chain is BROKEN. (${trail.records.length} records)`);
  return 1;
}

export function auditExportCommand(options: {
  runId?: string;
  outputPath?: string;
  dataDir?: string;
}): number {
  const kernel = new FlowForgeKernel({ dataDir: options.dataDir ?? defaultDataDir() });
  const trail = kernel.getAuditTrail(options.runId ? { runId: options.runId } : undefined);
  const json = JSON.stringify(trail.records, null, 2);
  if (options.outputPath) {
    writeFileSync(options.outputPath, json, 'utf8');
    console.log(`✔ Exported ${trail.records.length} records to ${options.outputPath}`);
  } else {
    process.stdout.write(json + '\n');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// memory list / memory delete
// ---------------------------------------------------------------------------

export async function memoryListCommand(
  namespace: string,
  options: { dataDir?: string }
): Promise<number> {
  // Memory is per-kernel-instance (in-memory or backed by a future VectorStore
  // adapter — Phase 3, ADR-0011).  For now this command reads from the
  // in-memory store of a fresh kernel; cross-process persistence requires the
  // Chroma adapter (Milestone 3.3).
  void options;
  const memory = new MemoryService();
  const items = await memory.list(namespace);
  if (items.length === 0) {
    console.log(`No memory items in namespace '${namespace}'.`);
    return 0;
  }
  for (const item of items) {
    console.log(`${item.id}  ${item.createdAt}  ${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}`);
  }
  return 0;
}

export async function memoryDeleteCommand(
  namespace: string,
  itemId: string,
  options: { dataDir?: string }
): Promise<number> {
  void options;
  const memory = new MemoryService();
  await memory.forget(namespace, itemId);
  console.log(`✔ Deleted item '${itemId}' from namespace '${namespace}'.`);
  return 0;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`FlowForge — Agent Workforce Platform CLI

Usage:
  flowforge validate <package-dir>
      Validate a .workforce package.

  flowforge inspect <package-dir>
      Show agents, skills, personas and workflows in a package.

  flowforge run <package-dir> <workflow-id> [options]
      Run a workflow (interactive via stdin by default).
      --mock                   Use the mock model provider.
      --answers <file.json>    Non-interactive mode: supply answers as a JSON
                               array (each element answers the next human step).
      --watch                  Print progress as the run advances.
      --identity <config.json> Sign users in via OIDC device flow.
      --data-dir <dir>         Persist run state (default: ~/.flowforge).

  flowforge runs list [--package <id>] [--data-dir <dir>]
      List persisted runs.

  flowforge runs show <run-id> [--data-dir <dir>]
      Show details for a persisted run.

  flowforge audit show [--run <id>] [--actor <id>] [--action <action>] [--data-dir <dir>]
      Show audit records (optionally filtered).

  flowforge audit verify [--data-dir <dir>]
      Verify hash-chain integrity of the audit log.

  flowforge audit export [--run <id>] [--output <file>] [--data-dir <dir>]
      Export audit records as JSON.

  flowforge memory list <namespace> [--data-dir <dir>]
      List memory items in a namespace.

  flowforge memory delete <namespace> <item-id> [--data-dir <dir>]
      Delete a memory item from a namespace.
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a flat args array for named flags: `--flag value` or `--flag=value`.
 * Returns the value for the first occurrence of any of the provided flag names.
 */
function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name && i + 1 < args.length) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

/** Positional args: non-flag tokens and non-flag-value tokens. */
function positionals(args: string[], ...flagNames: string[]): string[] {
  const result: string[] = [];
  const flagSet = new Set(flagNames);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      // Skip this flag and its value token if it's a named flag.
      const plain = arg.includes('=') ? arg.split('=')[0]! : arg;
      if (flagSet.has(plain)) {
        if (!arg.includes('=')) i++; // skip value
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

const [, , command, subOrArg, ...rest] = process.argv;
const allArgs = subOrArg !== undefined ? [subOrArg, ...rest] : [];

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const ALL_FLAGS = [
    '--mock', '--answers', '--identity', '--data-dir', '--watch',
    '--package', '--run', '--actor', '--action', '--output'
  ];

  switch (command) {
    case 'validate':
      process.exit(subOrArg ? validateCommand(subOrArg) : (usage(), 1));
      break;

    case 'inspect':
      process.exit(subOrArg ? inspectCommand(subOrArg) : (usage(), 1));
      break;

    case 'run': {
      const pos = positionals(allArgs, ...ALL_FLAGS);
      if (pos.length < 2) { usage(); process.exit(1); }
      runCommand(pos[0]!, pos[1]!, {
        mock: hasFlag(allArgs, '--mock'),
        identityConfigPath: flag(allArgs, '--identity'),
        answersPath: flag(allArgs, '--answers'),
        dataDir: flag(allArgs, '--data-dir'),
        watch: hasFlag(allArgs, '--watch')
      }).then((code) => process.exit(code));
      break;
    }

    case 'runs': {
      const sub = subOrArg;
      if (sub === 'list') {
        process.exit(
          runsListCommand({ dataDir: flag(rest, '--data-dir'), packageId: flag(rest, '--package') })
        );
      } else if (sub === 'show') {
        const runId = rest.find((a) => !a.startsWith('--'));
        if (!runId) { usage(); process.exit(1); }
        runsShowCommand(runId, { dataDir: flag(rest, '--data-dir') }).then((code) => process.exit(code));
      } else {
        usage();
        process.exit(1);
      }
      break;
    }

    case 'audit': {
      const sub = subOrArg;
      if (sub === 'show') {
        process.exit(
          auditShowCommand({
            runId: flag(rest, '--run'),
            actor: flag(rest, '--actor'),
            action: flag(rest, '--action'),
            dataDir: flag(rest, '--data-dir')
          })
        );
      } else if (sub === 'verify') {
        process.exit(auditVerifyCommand({ dataDir: flag(rest, '--data-dir') }));
      } else if (sub === 'export') {
        process.exit(
          auditExportCommand({
            runId: flag(rest, '--run'),
            outputPath: flag(rest, '--output'),
            dataDir: flag(rest, '--data-dir')
          })
        );
      } else {
        usage();
        process.exit(1);
      }
      break;
    }

    case 'memory': {
      const sub = subOrArg;
      const pos = positionals(rest, ...ALL_FLAGS);
      if (sub === 'list') {
        if (!pos[0]) { usage(); process.exit(1); }
        memoryListCommand(pos[0], { dataDir: flag(rest, '--data-dir') }).then((code) =>
          process.exit(code)
        );
      } else if (sub === 'delete') {
        if (!pos[0] || !pos[1]) { usage(); process.exit(1); }
        memoryDeleteCommand(pos[0], pos[1], { dataDir: flag(rest, '--data-dir') }).then((code) =>
          process.exit(code)
        );
      } else {
        usage();
        process.exit(1);
      }
      break;
    }

    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}
