import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  validate,
  type AgentDefinition,
  type LoadedSkill,
  type LoadedWorkforcePackage,
  type PersonaDefinition,
  type SkillManifest,
  type WorkforcePackageManifest,
  type WorkflowDefinition
} from '@flowforge/core';

export class PackageValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[]
  ) {
    super(`${message}: ${errors.join('; ')}`);
    this.name = 'PackageValidationError';
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parses a SKILL.md file (agentskills.io Agent Skills convention): YAML
 * frontmatter is the skill manifest, the Markdown body is the instructions.
 */
export function parseSkillFile(path: string, label: string): LoadedSkill {
  const source = readFileSync(path, 'utf8');
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    throw new PackageValidationError(`Invalid ${label}`, [
      'SKILL.md must start with a YAML frontmatter block delimited by ---'
    ]);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (error) {
    throw new PackageValidationError(`Invalid ${label}`, [
      `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    ]);
  }
  assertValid('skill', frontmatter, label);
  const manifest = frontmatter as SkillManifest;
  const dir = dirname(path);
  if (manifest.name !== basename(dir)) {
    throw new PackageValidationError(`Invalid ${label}`, [
      `frontmatter name '${manifest.name}' must match the skill folder name '${basename(dir)}'`
    ]);
  }
  return { manifest, instructions: source.slice(match[0].length).trim(), dir };
}

function assertValid(schema: Parameters<typeof validate>[0], doc: unknown, label: string): void {
  const result = validate(schema, doc);
  if (!result.valid) throw new PackageValidationError(`Invalid ${label}`, result.errors);
}

/**
 * Loads and validates a directory-form .workforce package.
 * Validation covers schema conformance plus cross-references:
 * agents' skills/personas must exist, workflow nodes must reference known
 * agents and known node ids.
 */
export function loadWorkforcePackage(packageDir: string): LoadedWorkforcePackage {
  const rootDir = resolve(packageDir);
  const manifest = readJson(join(rootDir, 'workforce.json')) as WorkforcePackageManifest;
  assertValid('workforce-package', manifest, 'workforce.json');

  const agents = new Map<string, AgentDefinition>();
  for (const relPath of manifest.agents) {
    const agentPath = join(rootDir, relPath);
    const agent = readJson(agentPath) as AgentDefinition;
    assertValid('agent', agent, relPath);
    if (agents.has(agent.id)) {
      throw new PackageValidationError('Duplicate agent id', [agent.id]);
    }
    if (agent.systemPrompt) {
      // resolve prompt relative to the agent file and inline it
      agent.systemPrompt = readFileSync(join(dirname(agentPath), agent.systemPrompt), 'utf8');
    }
    agents.set(agent.id, agent);
  }

  const skills = new Map<string, LoadedSkill>();
  for (const relPath of manifest.skills ?? []) {
    const skill = parseSkillFile(join(rootDir, relPath), relPath);
    if (skills.has(skill.manifest.name)) {
      throw new PackageValidationError('Duplicate skill name', [skill.manifest.name]);
    }
    skills.set(skill.manifest.name, skill);
  }

  const personas = new Map<string, PersonaDefinition>();
  for (const relPath of manifest.personas ?? []) {
    const persona = readJson(join(rootDir, relPath)) as PersonaDefinition;
    assertValid('persona', persona, relPath);
    personas.set(persona.id, persona);
  }

  const workflows = new Map<string, WorkflowDefinition>();
  for (const relPath of manifest.workflows) {
    const workflow = readJson(join(rootDir, relPath)) as WorkflowDefinition;
    assertValid('workflow', workflow, relPath);
    workflows.set(workflow.id, workflow);
  }

  const crossErrors: string[] = [];
  for (const agent of agents.values()) {
    for (const skillId of agent.skills ?? []) {
      if (!skills.has(skillId)) crossErrors.push(`agent '${agent.id}' references unknown skill '${skillId}'`);
    }
    if (agent.defaultPersona && !personas.has(agent.defaultPersona)) {
      crossErrors.push(`agent '${agent.id}' references unknown persona '${agent.defaultPersona}'`);
    }
  }
  for (const workflow of workflows.values()) {
    const nodeIds = new Set(workflow.nodes.map((n) => n.id));
    if (!nodeIds.has(workflow.start)) {
      crossErrors.push(`workflow '${workflow.id}' start node '${workflow.start}' not found`);
    }
    for (const node of workflow.nodes) {
      if (node.type === 'agent' && !agents.has(node.agent)) {
        crossErrors.push(`workflow '${workflow.id}' node '${node.id}' references unknown agent '${node.agent}'`);
      }
      const targets: (string | undefined)[] = [node.next];
      if (node.type === 'humanApproval') targets.push(node.onApprove, node.onReject);
      if (node.type === 'branch') targets.push(...node.conditions.map((c) => c.next));
      if (node.type === 'parallel') targets.push(...node.branches);
      for (const target of targets) {
        if (target && !nodeIds.has(target)) {
          crossErrors.push(`workflow '${workflow.id}' node '${node.id}' points to unknown node '${target}'`);
        }
      }
    }
  }
  if (crossErrors.length > 0) {
    throw new PackageValidationError('Cross-reference validation failed', crossErrors);
  }

  return { rootDir, manifest, agents, skills, personas, workflows };
}
