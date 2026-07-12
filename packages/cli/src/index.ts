#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadWorkforcePackage, PackageValidationError } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry, OllamaProvider } from '@flowforge/agents';
import { WorkflowEngine } from '@flowforge/workflow';

function usage(): void {
  console.log(`FlowForge — Agent Workforce Platform CLI

Usage:
  flowforge validate <package-dir>          Validate a .workforce package
  flowforge inspect <package-dir>           Show agents, skills, personas, workflows
  flowforge run <package-dir> <workflow-id> Run a workflow headlessly (interactive human steps via stdin; --mock uses a mock model)
`);
}

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

export function inspectCommand(packageDir: string): number {
  try {
    const pkg = loadWorkforcePackage(packageDir);
    console.log(`${pkg.manifest.name} v${pkg.manifest.version} — ${pkg.manifest.description ?? ''}`);
    console.log('\nAgents:');
    for (const agent of pkg.agents.values()) {
      console.log(`  ${agent.id} (${agent.model.tier}) — ${agent.role}`);
    }
    console.log('\nSkills:');
    for (const skill of pkg.skills.values()) console.log(`  ${skill.id} v${skill.version}`);
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

async function prompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

export async function runCommand(
  packageDir: string,
  workflowId: string,
  options: { mock?: boolean } = {}
): Promise<number> {
  const pkg = loadWorkforcePackage(packageDir);
  const workflow = pkg.workflows.get(workflowId);
  if (!workflow) {
    console.error(`✘ Unknown workflow '${workflowId}'. Available: ${[...pkg.workflows.keys()].join(', ')}`);
    return 1;
  }

  const provider = options.mock
    ? new MockModelProvider(() => JSON.stringify({ note: 'mock response' }))
    : new OllamaProvider();
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const engine = new WorkflowEngine(new AgentRuntime(pkg, models, new MemoryService(), audit), audit);

  let run = await engine.start(workflow);
  while (run.status === 'waitingForHuman' && run.pending) {
    const pending = run.pending;
    if (pending.kind === 'input') {
      const value = await prompt(`[${pending.role}] ${pending.prompt ?? 'Provide input'}: `);
      run = await engine.resume(workflow, run.id, { userId: pending.role, value });
    } else {
      console.log(`Subject for review:\n${JSON.stringify(pending.subject, null, 2)}`);
      const answer = await prompt(`[${pending.role}] Approve? (y/n): `);
      const approved = answer.trim().toLowerCase().startsWith('y');
      const reason = await prompt(`[${pending.role}] Reason: `);
      run = await engine.resume(workflow, run.id, { userId: pending.role, approved, reason });
    }
  }

  console.log(`\nRun ${run.id} finished with status: ${run.status}`);
  if (run.error) console.error(`Error: ${run.error}`);
  console.log(`\nAudit trail (${audit.all().length} records, chain ${audit.verify() === -1 ? 'intact' : 'BROKEN'}):`);
  for (const record of audit.all()) {
    console.log(`  ${record.timestamp} ${record.actor.type}:${record.actor.id} ${record.action}${record.nodeId ? ` @${record.nodeId}` : ''}`);
  }
  return run.status === 'completed' ? 0 : 1;
}

const [, , command, ...args] = process.argv;
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
    case 'validate':
      process.exit(args[0] ? validateCommand(args[0]) : (usage(), 1));
      break;
    case 'inspect':
      process.exit(args[0] ? inspectCommand(args[0]) : (usage(), 1));
      break;
    case 'run': {
      const mock = args.includes('--mock');
      const positional = args.filter((a) => !a.startsWith('--'));
      if (positional.length < 2) {
        usage();
        process.exit(1);
      }
      runCommand(positional[0]!, positional[1]!, { mock }).then((code) => process.exit(code));
      break;
    }
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}
