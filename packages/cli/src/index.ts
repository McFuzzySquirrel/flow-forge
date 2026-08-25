#!/usr/bin/env node
/**
 * FlowForge CLI — the terminal-first reference surface (ADR-0011).
 *
 * All commands go through FlowForgeKernel, so every operation available in a
 * future UI is also exercisable from a terminal or CI script.
 *
 * Commands:
 *   validate <package-dir> [--graph]
 *   inspect  <package-dir>
 *   run      <package-dir> <workflow-id> [--mock] [--answers <file.json>] [--data-dir <dir>] [--identity <config.json>] [--persona <id>]
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
import { FileVectorStore, MemoryService } from '@flowforge/memory';
import {
  AgentRuntime,
  DeepSeekProvider,
  MockModelProvider,
  ModelRegistry,
  OllamaProvider,
  OpenAICompatibleProvider
} from '@flowforge/agents';
import { IdentityService, MockIdentityProvider } from '@flowforge/identity';
import { WorkflowEngine } from '@flowforge/workflow';
import { FlowForgeKernel, ENGINE_VERSION } from '@flowforge/kernel';
import {
  defaultArchivePath,
  generateSigningKeypair,
  packWorkforce,
  publicKeyFingerprint,
  publicKeyFromPrivate,
  unpackWorkforce,
  verifyWorkforceArchive
} from '@flowforge/packaging';
import { prompt } from './io.js';
import { loadConfig, type FlowForgeConfig } from './config.js';
import { doctorChecks, printChecks, runSetup } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  return join(homedir(), '.flowforge');
}

/** Data dir from an explicit flag, else the configured vector store, else ~/.flowforge. */
function resolveDataDir(override: string | undefined, config: FlowForgeConfig): string {
  if (override) return override;
  if (config.vectorStore.type === 'file') return config.vectorStore.dataDir;
  return defaultDataDir();
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
  return validateCommandWithOptions(packageDir);
}

export function validateCommandWithOptions(packageDir: string, options: { graph?: boolean } = {}): number {
  if (options.graph) {
    const kernel = new FlowForgeKernel();
    const result = kernel.validatePackage(packageDir);
    if (result.errors.length > 0) {
      console.error(`✘ Package validation failed:`);
      for (const detail of result.errors) console.error(`  - ${detail}`);
    }
    if (result.graphErrors.length > 0) {
      console.error(`✘ Graph validation failed:`);
      for (const detail of result.graphErrors) console.error(`  - ${detail}`);
    } else if (result.valid) {
      console.log('✔ No graph errors');
    }
    return result.valid ? 0 : 1;
  }
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

/** Resolve a model provider from the `--provider`/`--api-key` flags, env or config (default Ollama). */
function resolveProvider(
  providerName: string | undefined,
  apiKey: string | undefined,
  config: FlowForgeConfig
): import('@flowforge/agents').ModelProvider {
  const key = apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  switch (providerName) {
    case 'deepseek':
      if (!key) throw new Error('DeepSeek requires an API key (--api-key or DEEPSEEK_API_KEY)');
      return new DeepSeekProvider(key);
    case 'openai': {
      if (!key) throw new Error('OpenAI requires an API key (--api-key or OPENAI_API_KEY)');
      const cloud = config.provider.cloud;
      return new OpenAICompatibleProvider(
        cloud?.baseUrl ?? 'https://api.openai.com/v1',
        key,
        cloud?.model ?? 'gpt-4o-mini'
      );
    }
    case undefined:
    case 'ollama': {
      const ollama = config.provider.ollama;
      return new OllamaProvider(ollama?.url ?? 'http://localhost:11434', ollama?.model ?? 'llama3.2');
    }
    case 'hybrid':
      throw new Error("'hybrid' is resolved per tier; run 'flowforge setup' to configure a hybrid mapping");
    default:
      throw new Error(`Unknown provider '${providerName}' (expected 'ollama', 'deepseek', 'openai' or 'hybrid')`);
  }
}

/** Build a ModelRegistry honouring a per-tier hybrid mapping from config. */
function resolveModelRegistry(
  providerName: string | undefined,
  apiKey: string | undefined,
  config: FlowForgeConfig
): ModelRegistry {
  const name = providerName ?? process.env.FLOWFORGE_PROVIDER ?? config.provider.type;
  const registry = new ModelRegistry();
  if (name === 'hybrid') {
    const hybrid = config.provider.hybrid;
    if (!hybrid) throw new Error("'hybrid' selected but config.provider.hybrid is missing (run 'flowforge setup')");
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    const tiers = ['small', 'medium', 'large'] as const;
    for (const tier of tiers) {
      const spec = hybrid[tier];
      if (!spec) throw new Error(`Hybrid mapping is missing tier '${tier}'`);
      let provider: import('@flowforge/agents').ModelProvider;
      if (spec.type === 'ollama') {
        provider = new OllamaProvider(config.provider.ollama?.url ?? 'http://localhost:11434', spec.model);
      } else {
        if (!key) throw new Error('Cloud tier requires an API key (--api-key or OPENAI_API_KEY)');
        provider = new OpenAICompatibleProvider(
          config.provider.cloud?.baseUrl ?? 'https://api.openai.com/v1',
          key,
          spec.model
        );
      }
      registry.set(tier, provider);
    }
    return registry;
  }
  return registry.set('small', resolveProvider(name, apiKey, config)).set('medium', resolveProvider(name, apiKey, config)).set('large', resolveProvider(name, apiKey, config));
}

export async function runCommand(
  packageDir: string,
  workflowId: string,
  options: {
    mock?: boolean;
    identityConfigPath?: string;
    answersPath?: string;
    dataDir?: string;
    watch?: boolean;
    persona?: string;
    provider?: string;
    apiKey?: string;
    config?: string;
  } = {}
): Promise<number> {
  const pkg = loadWorkforcePackage(packageDir);
  const workflow = pkg.workflows.get(workflowId);
  if (!workflow) {
    console.error(`✘ Unknown workflow '${workflowId}'. Available: ${[...pkg.workflows.keys()].join(', ')}`);
    return 1;
  }
  const persona = options.persona ? pkg.personas.get(options.persona) : undefined;
  if (options.persona && !persona) {
    console.error(`✘ Unknown persona '${options.persona}'. Available: ${[...pkg.personas.keys()].join(', ')}`);
    return 1;
  }

  // Scripted (non-interactive) answers for CI / headless runs.
  const answers: ScriptedAnswer[] = options.answersPath
    ? (JSON.parse(readFileSync(options.answersPath, 'utf8')) as ScriptedAnswer[])
    : [];
  let answerIndex = 0;

  const provider = options.mock
    ? new MockModelProvider(() => JSON.stringify({ note: 'mock response' }))
    : undefined;
  const config = loadConfig(options.config);
  const models = options.mock
    ? new ModelRegistry().set('small', provider!).set('medium', provider!).set('large', provider!)
    : resolveModelRegistry(options.provider, options.apiKey, config);
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

  let run = await engine.start(
    workflow,
    options.persona
      ? {
          personaId: options.persona,
          personaPolicy: persona?.decisionPolicy
            ? ({ ...persona.decisionPolicy } as Record<string, unknown>)
            : undefined
        }
      : undefined
  );
  if (options.watch) console.log(`Run ${run.id} started (${run.status})`);

  while (run.status === 'waitingForHuman' && run.pending) {
    const pending = run.pending;
    const principal = await principalFor(pending.role);

    if (options.watch) {
      console.log(`  ↳ waiting for ${pending.role} at node '${pending.nodeId}' (${pending.kind})`);
    }

    // Use next scripted answer if available, otherwise prompt interactively.
    const answer = answerIndex < answers.length ? answers[answerIndex++] : undefined;

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
  if (options.dataDir || config.vectorStore.type === 'file') {
    const dataDir = resolveDataDir(options.dataDir, config);
    const kernel = new FlowForgeKernel({ dataDir });
    kernel.importRun(packageDir, run, audit.all());
    console.log(`\n✔ Run persisted to ${dataDir}`);
  }  return run.status === 'completed' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// runs list / runs show
// ---------------------------------------------------------------------------

export function runsListCommand(options: { dataDir?: string; packageId?: string; config?: string }): number {
  const kernel = new FlowForgeKernel({ dataDir: resolveDataDir(options.dataDir, loadConfig(options.config)) });
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

export async function runsShowCommand(runId: string, options: { dataDir?: string; config?: string }): Promise<number> {
  const kernel = new FlowForgeKernel({ dataDir: resolveDataDir(options.dataDir, loadConfig(options.config)) });
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
  runIds?: string[];
  actor?: string;
  action?: string;
  dataDir?: string;
  config?: string;
}): number {
  const kernel = new FlowForgeKernel({ dataDir: resolveDataDir(options.dataDir, loadConfig(options.config)) });
  const runIds = [
    ...(options.runId ? [options.runId] : []),
    ...(options.runIds ?? [])
  ];
  const trail = kernel.getAuditTrail({
    runIds: runIds.length > 0 ? runIds : undefined,
    actor: options.actor,
    action: options.action
  });
  if (trail.records.length === 0) {
    console.log('No audit records match the filter.');
    return 0;
  }
  if (runIds.length === 2) {
    const printRun = (runId: string) => {
      console.log(`Run ${runId}:`);
      const records = trail.records.filter(
        (record) => record.workflowRunId === runId && record.action === 'agent.step'
      );
      if (records.length === 0) {
        console.log('  (no agent steps)');
        return;
      }
      for (const record of records) {
        console.log(
          `  ${record.nodeId ?? '-'}  agent=${record.actor.id}  persona=${record.actor.persona ?? '—'}  score=${record.score ?? '—'}`
        );
      }
    };

    const [runA, runB] = runIds;
    printRun(runA!);
    console.log('');
    printRun(runB!);
    console.log('\nSummary:');

    const recordsByRun = new Map(
      runIds.map((runId) => [
        runId,
        new Map(
          trail.records
            .filter((record) => record.workflowRunId === runId && record.action === 'agent.step')
            .map((record) => [record.nodeId ?? record.id, record] as const)
        )
      ] as const)
    );
    const nodeIds = new Set([
      ...recordsByRun.get(runA!)!.keys(),
      ...recordsByRun.get(runB!)!.keys()
    ]);
    for (const nodeId of nodeIds) {
      const left = recordsByRun.get(runA!)!.get(nodeId);
      const right = recordsByRun.get(runB!)!.get(nodeId);
      const scoreDiff =
        typeof left?.score === 'number' && typeof right?.score === 'number'
          ? right.score - left.score
          : undefined;
      console.log(
        `  ${nodeId}  personas=${left?.actor.persona ?? '—'} vs ${right?.actor.persona ?? '—'}  scores=${left?.score ?? '—'} vs ${right?.score ?? '—'}${scoreDiff !== undefined ? `  Δ=${scoreDiff}` : ''}`
      );
    }
    console.log(`\nchain: ${trail.chainIntact ? 'intact ✔' : 'BROKEN ✘'} (${trail.records.length} records)`);
    return trail.chainIntact ? 0 : 1;
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

export function auditVerifyCommand(options: { dataDir?: string; config?: string }): number {
  const kernel = new FlowForgeKernel({ dataDir: resolveDataDir(options.dataDir, loadConfig(options.config)) });
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
  config?: string;
}): number {
  const kernel = new FlowForgeKernel({ dataDir: resolveDataDir(options.dataDir, loadConfig(options.config)) });
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
  options: { dataDir?: string; config?: string }
): Promise<number> {
  const dataDir = resolveDataDir(options.dataDir, loadConfig(options.config));
  const store = new FileVectorStore(dataDir);
  const memory = new MemoryService(store);
  const items = await memory.list(namespace);
  if (items.length === 0) {
    console.log(`No memory items in namespace '${namespace}'.`);
    return 0;
  }
  for (const item of items) {
    const meta = item.metadata ? `  ${JSON.stringify(item.metadata)}` : '';
    console.log(`${item.id}  ${item.createdAt}  ${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}${meta}`);
  }
  return 0;
}

export async function memoryDeleteCommand(
  namespace: string,
  itemId: string,
  options: { dataDir?: string; config?: string }
): Promise<number> {
  const store = new FileVectorStore(resolveDataDir(options.dataDir, loadConfig(options.config)));
  const memory = new MemoryService(store);
  await memory.forget(namespace, itemId);
  console.log(`✔ Deleted item '${itemId}' from namespace '${namespace}'.`);
  return 0;
}

// ---------------------------------------------------------------------------
// pack / unpack / verify (Phase 4.1 — ecosystem)
// ---------------------------------------------------------------------------

export function packCommand(
  packageDir: string,
  options: { outputPath?: string; signingKeyPath?: string; publisher?: string } = {}
): number {
  try {
    let signingKey: ReturnType<typeof generateSigningKeypair> | undefined;
    if (options.signingKeyPath) {
      const privateKey = readFileSync(options.signingKeyPath, 'utf8');
      signingKey = { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
    }
    const outputPath = options.outputPath ?? defaultArchivePath(packageDir);
    const result = packWorkforce(packageDir, outputPath, {
      signingKey,
      publisher: options.publisher
    });
    console.log(`✔ Packed ${result.packageId} v${result.packageVersion} (${result.fileCount} files)`);
    console.log(`  → ${result.archivePath}`);
    console.log(result.signed ? `  signed by ${result.signerFingerprint}` : '  unsigned (use --signing-key to sign)');
    return 0;
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function unpackCommand(archivePath: string, options: { outputDir?: string } = {}): number {
  try {
    const outputDir = options.outputDir ?? archivePath.replace(/\.workforce$/, '');
    const files = unpackWorkforce(archivePath, outputDir);
    console.log(`✔ Unpacked ${archivePath} (${files.length} files) → ${outputDir}`);
    return 0;
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function verifyCommand(archivePath: string): number {
  const result = verifyWorkforceArchive(archivePath, { engineVersion: ENGINE_VERSION });
  if (result.valid) {
    console.log(`✔ ${archivePath} is valid`);
    console.log(`  package: ${result.packageId} v${result.packageVersion}`);
    console.log(`  hash manifest: intact (${result.hashesIntact ? 'yes' : 'no'})`);
    if (result.signed) {
      console.log(`  signature: VALID — signed by ${result.signerFingerprint}`);
    } else {
      console.warn('  signature: unsigned — authenticity not proven');
    }
    if (result.engineCompatible === false) {
      console.warn(`  engine compatibility: ${result.engineReason}`);
    } else {
      console.log(`  engine compatibility: OK (engine ${ENGINE_VERSION})`);
    }
    return 0;
  }
  console.error(`✘ ${archivePath} is NOT valid:`);
  for (const detail of result.errors) console.error(`  - ${detail}`);
  return 1;
}

export function generateKeyCommand(outputPath: string): number {
  try {
    const keypair = generateSigningKeypair();
    writeFileSync(`${outputPath}`, keypair.privateKey, 'utf8');
    console.log(`✔ Generated Ed25519 signing key → ${outputPath}`);
    console.log(`  public key fingerprint: ${publicKeyFingerprint(publicKeyFromPrivate(keypair.privateKey))}`);
    return 0;
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`FlowForge — Agent Workforce Platform CLI

Usage:
  flowforge setup [options]
      Interactively configure providers, models, vector store and identity.
      --non-interactive        Do not prompt; read every value from flags/config.
      --provider <name>        ollama (default), deepseek, openai or hybrid.
      --api-key <key>          API key for cloud providers (also written to .env).
      --ollama-url <url>       Ollama server URL (default: http://localhost:11434).
      --ollama-model <model>   Default chat model (default: llama3.2).
      --embedding-model <m>    Embedding model (default: nomic-embed-text).
      --cloud-url <url>        OpenAI-compatible base URL.
      --cloud-model <model>    Default cloud model (default: gpt-4o-mini).
      --vector-store <type>    file (default) or chroma.
      --chroma-url <url>       Chroma URL (default: http://localhost:8000).
      --data-dir <dir>         File-backed data directory (default: ~/.flowforge).
      --identity-mode <mode>   dev (default) or oidc.
      --oidc-config <path>     OIDC identity config JSON (for --identity-mode oidc).
      --config <path>          Write config here (default: ~/.flowforge/config.json).
      --apply                  Allow mutating actions (ollama pull, docker run).
      --skip-validation        Skip live provider connectivity checks.

  flowforge doctor
      Print a read-only environment health check (node, pnpm, build, ollama).

  flowforge validate <package-dir>
      Validate a .workforce package.
      --graph                  Also validate workflow graph reachability.

  flowforge inspect <package-dir>
      Show agents, skills, personas and workflows in a package.

  flowforge run <package-dir> <workflow-id> [options]
      Run a workflow (interactive via stdin by default).
      --mock                   Use the mock model provider.
      --provider <name>        Model provider: ollama (default), deepseek, openai, hybrid.
      --api-key <key>          API key for cloud providers (or DEEPSEEK_API_KEY / OPENAI_API_KEY env).
      --answers <file.json>    Non-interactive mode: supply answers as a JSON
                               array (each element answers the next human step).
      --watch                  Print progress as the run advances.
      --identity <config.json> Sign users in via OIDC device flow.
      --persona <id>           Override the run persona for agent steps.
      --data-dir <dir>         Persist run state (default: from config, else ~/.flowforge).
      --config <path>          Read config from this file instead of repo/user defaults.

  flowforge runs list [--package <id>] [--data-dir <dir>] [--config <path>]
      List persisted runs.

  flowforge runs show <run-id> [--data-dir <dir>] [--config <path>]
      Show details for a persisted run.

  flowforge audit show [--run <id>] [--actor <id>] [--action <action>] [--data-dir <dir>] [--config <path>]
      Show audit records (optionally filtered).

  flowforge audit verify [--data-dir <dir>] [--config <path>]
      Verify hash-chain integrity of the audit log.

  flowforge audit export [--run <id>] [--output <file>] [--data-dir <dir>] [--config <path>]
      Export audit records as JSON.

  flowforge memory list <namespace> [--data-dir <dir>] [--config <path>]
      List memory items in a namespace.

  flowforge memory delete <namespace> <item-id> [--data-dir <dir>] [--config <path>]
      Delete a memory item from a namespace.

  flowforge pack <package-dir> [options]
      Pack a .workforce directory into a deterministic, optionally signed archive.
      --output <file>          Output archive path (default: <package-id>-<version>.workforce).
      --signing-key <key.pem>  Sign with this Ed25519 private key (PEM).
      --publisher <name>       Publisher name recorded in the signature block.

  flowforge unpack <archive> [--output <dir>]
      Unpack a .workforce archive back into a directory.

  flowforge verify <archive>
      Verify an archive: hash integrity, Ed25519 signature and engine compatibility.

  flowforge keygen <output.pem>
      Generate a new Ed25519 signing keypair (private key written to the given path).
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

function flags(args: string[], ...names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name && i + 1 < args.length) values.push(args[i + 1]!);
      else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    }
  }
  return values;
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

const VALUE_FLAGS = ['--answers', '--identity', '--data-dir', '--package', '--run', '--actor', '--action', '--output', '--persona', '--provider', '--api-key', '--config', '--ollama-url', '--ollama-model', '--embedding-model', '--cloud-url', '--cloud-model', '--vector-store', '--chroma-url', '--identity-mode', '--oidc-config', '--signing-key', '--publisher'];

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
  switch (command) {
    case 'validate': {
      const pos = positionals(allArgs, ...VALUE_FLAGS);
      process.exit(pos[0] ? validateCommandWithOptions(pos[0], { graph: hasFlag(allArgs, '--graph') }) : (usage(), 1));
      break;
    }

    case 'inspect':
      process.exit(subOrArg ? inspectCommand(subOrArg) : (usage(), 1));
      break;

    case 'run': {
      const pos = positionals(allArgs, ...VALUE_FLAGS);
      if (pos.length < 2) { usage(); process.exit(1); }
      runCommand(pos[0]!, pos[1]!, {
        mock: hasFlag(allArgs, '--mock'),
        identityConfigPath: flag(allArgs, '--identity'),
        answersPath: flag(allArgs, '--answers'),
        dataDir: flag(allArgs, '--data-dir'),
        watch: hasFlag(allArgs, '--watch'),
        persona: flag(allArgs, '--persona'),
        provider: flag(allArgs, '--provider'),
        apiKey: flag(allArgs, '--api-key'),
        config: flag(allArgs, '--config')
      }).then((code) => process.exit(code));
      break;
    }

    case 'runs': {
      const sub = subOrArg;
      if (sub === 'list') {
        process.exit(
          runsListCommand({ dataDir: flag(rest, '--data-dir'), packageId: flag(rest, '--package'), config: flag(rest, '--config') })
        );
      } else if (sub === 'show') {
        const runId = rest.find((a) => !a.startsWith('--'));
        if (!runId) { usage(); process.exit(1); }
        runsShowCommand(runId, { dataDir: flag(rest, '--data-dir'), config: flag(rest, '--config') }).then((code) => process.exit(code));
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
            runIds: flags(rest, '--run'),
            actor: flag(rest, '--actor'),
            action: flag(rest, '--action'),
            dataDir: flag(rest, '--data-dir'),
            config: flag(rest, '--config')
          })
        );
      } else if (sub === 'verify') {
        process.exit(auditVerifyCommand({ dataDir: flag(rest, '--data-dir'), config: flag(rest, '--config') }));
      } else if (sub === 'export') {
        process.exit(
          auditExportCommand({
            runId: flag(rest, '--run'),
            outputPath: flag(rest, '--output'),
            dataDir: flag(rest, '--data-dir'),
            config: flag(rest, '--config')
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
      const pos = positionals(rest, ...VALUE_FLAGS);
      if (sub === 'list') {
        if (!pos[0]) { usage(); process.exit(1); }
        memoryListCommand(pos[0], { dataDir: flag(rest, '--data-dir'), config: flag(rest, '--config') }).then((code) =>
          process.exit(code)
        );
      } else if (sub === 'delete') {
        if (!pos[0] || !pos[1]) { usage(); process.exit(1); }
        memoryDeleteCommand(pos[0], pos[1], { dataDir: flag(rest, '--data-dir'), config: flag(rest, '--config') }).then((code) =>
          process.exit(code)
        );
      } else {
        usage();
        process.exit(1);
      }
      break;
    }

    case 'pack': {
      const pos = positionals(allArgs, ...VALUE_FLAGS);
      process.exit(
        pos[0]
          ? packCommand(pos[0], {
              outputPath: flag(allArgs, '--output'),
              signingKeyPath: flag(allArgs, '--signing-key'),
              publisher: flag(allArgs, '--publisher')
            })
          : (usage(), 1)
      );
      break;
    }

    case 'unpack':
      process.exit(
        subOrArg ? unpackCommand(subOrArg, { outputDir: flag(allArgs, '--output') }) : (usage(), 1)
      );
      break;

    case 'verify':
      process.exit(subOrArg ? verifyCommand(subOrArg) : (usage(), 1));
      break;

    case 'keygen':
      process.exit(subOrArg ? generateKeyCommand(subOrArg) : (usage(), 1));
      break;

    case 'setup':
      runSetup({
        nonInteractive: hasFlag(allArgs, '--non-interactive'),
        configPath: flag(allArgs, '--config'),
        provider: flag(allArgs, '--provider') as 'ollama' | 'deepseek' | 'openai' | 'hybrid' | undefined,
        apiKey: flag(allArgs, '--api-key'),
        ollamaUrl: flag(allArgs, '--ollama-url'),
        ollamaModel: flag(allArgs, '--ollama-model'),
        embeddingModel: flag(allArgs, '--embedding-model'),
        cloudBaseUrl: flag(allArgs, '--cloud-url'),
        cloudModel: flag(allArgs, '--cloud-model'),
        vectorStore: flag(allArgs, '--vector-store') as 'file' | 'chroma' | undefined,
        chromaUrl: flag(allArgs, '--chroma-url'),
        dataDir: flag(allArgs, '--data-dir'),
        identityMode: flag(allArgs, '--identity-mode') as 'dev' | 'oidc' | undefined,
        identityConfigPath: flag(allArgs, '--oidc-config'),
        apply: hasFlag(allArgs, '--apply'),
        skipValidation: hasFlag(allArgs, '--skip-validation')
      }).then((code) => process.exit(code));
      break;

    case 'doctor':
      doctorChecks().then((checks) => {
        printChecks(checks);
        process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
      });
      break;

    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}
