/** Domain types mirroring the JSON Schemas in ../schemas. Schemas are the source of truth. */

export interface WorkforcePackageManifest {
  specVersion: '1.0';
  id: string;
  name: string;
  version: string;
  description?: string;
  domain?: string;
  authors?: string[];
  license?: string;
  agents: string[];
  skills?: string[];
  personas?: string[];
  workflows: string[];
  rubrics?: string[];
  knowledge?: { path: string; agents: string[] }[];
  permissions?: { network?: boolean; fileSystem?: boolean };
  branding?: { displayName?: string; icon?: string; primaryColor?: string };
  signing?: { algorithm?: string; signature?: string; publisher?: string };
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  defaultPersona?: string;
  model: {
    tier: 'small' | 'medium' | 'large';
    preferredProvider?: string;
    preferredModel?: string;
    temperature?: number;
  };
  memory?: { enabled?: boolean; namespace?: string };
  permissions?: {
    canSeeRubricAnswers?: boolean;
    canGrade?: boolean;
    canAccessLearnerHistory?: boolean;
    network?: boolean;
  };
  outputSchema?: Record<string, unknown>;
}

/** Parsed YAML frontmatter of a SKILL.md file (agentskills.io convention). */
export interface SkillManifest {
  /** Skill identifier: lowercase letters, digits and hyphens, matching the skill folder name. */
  name: string;
  description: string;
  version?: string;
  license?: string;
  'allowed-tools'?: string[];
  metadata?: {
    displayName?: string;
    prompts?: string[];
    tools?: string;
    embeddings?: string[];
    dependencies?: string[];
    compatibleAgents?: string[];
    [key: string]: unknown;
  };
}

/** A skill resolved from disk: frontmatter manifest plus the SKILL.md instructions body. */
export interface LoadedSkill {
  manifest: SkillManifest;
  /** Markdown body of SKILL.md — the skill's instructions. */
  instructions: string;
  /** Absolute path to the skill folder. */
  dir: string;
}

export interface PersonaDefinition {
  id: string;
  name: string;
  description?: string;
  tone?: string;
  promptOverlay: string;
  decisionPolicy?: {
    strictness?: 'lenient' | 'balanced' | 'strict';
    givesDirectAnswers?: boolean;
    encouragementLevel?: 'low' | 'medium' | 'high';
  };
  compatibleAgents?: string[];
}

export type WorkflowNodeType =
  | 'agent'
  | 'humanApproval'
  | 'humanInput'
  | 'branch'
  | 'parallel'
  | 'end';

export interface WorkflowNodeBase {
  id: string;
  type: WorkflowNodeType;
  next?: string;
}

export interface AgentNode extends WorkflowNodeBase {
  type: 'agent';
  agent: string;
  action: string;
  persona?: string;
  inputs?: string[];
  output?: string;
  retry?: { maxAttempts?: number };
}

export interface HumanApprovalNode extends WorkflowNodeBase {
  type: 'humanApproval';
  role: string;
  subject?: string;
  onApprove?: string;
  onReject?: string;
}

export interface HumanInputNode extends WorkflowNodeBase {
  type: 'humanInput';
  role: string;
  prompt?: string;
  output: string;
}

export interface BranchNode extends WorkflowNodeBase {
  type: 'branch';
  conditions: { when: string; next: string }[];
}

export interface ParallelNode extends WorkflowNodeBase {
  type: 'parallel';
  branches: string[];
}

export interface EndNode extends WorkflowNodeBase {
  type: 'end';
}

export type WorkflowNode =
  | AgentNode
  | HumanApprovalNode
  | HumanInputNode
  | BranchNode
  | ParallelNode
  | EndNode;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  start: string;
  state?: Record<string, unknown>;
  deadline?: string;
  nodes: WorkflowNode[];
}

export interface AuditActor {
  type: 'agent' | 'human' | 'system';
  id: string;
  persona?: string;
  /** Identity provider that asserted a human actor's identity. */
  provider?: string;
  /** FlowForge roles held by the actor at the time of the action. */
  roles?: string[];
}

export interface AuditEvidence {
  source: string;
  excerpt?: string;
  relevance?: number;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: AuditActor;
  action: string;
  workflowRunId?: string;
  nodeId?: string;
  packageId?: string;
  inputRefs?: string[];
  promptVersion?: string;
  model?: { provider?: string; name?: string };
  evidence?: AuditEvidence[];
  rubricSection?: string;
  score?: number;
  confidence?: number;
  override?: { originalValue: unknown; newValue: unknown; reason: string };
  detail?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

/** A fully loaded, validated workforce package resolved from disk. */
export interface LoadedWorkforcePackage {
  rootDir: string;
  manifest: WorkforcePackageManifest;
  agents: Map<string, AgentDefinition>;
  skills: Map<string, LoadedSkill>;
  personas: Map<string, PersonaDefinition>;
  workflows: Map<string, WorkflowDefinition>;
}

/** An authenticated user, normalized across identity providers (ADR-0010). */
export interface Principal {
  /** Stable subject identifier from the identity provider ('sub' claim). */
  id: string;
  displayName?: string;
  email?: string;
  /** Id of the identity provider that authenticated this principal. */
  provider: string;
  /** Raw group memberships asserted by the provider. */
  groups?: string[];
  /** FlowForge roles resolved via the deployment's claim-to-role mappings. */
  roles: string[];
}

/** Actions a role may perform, granted via identity configuration. */
export type Permission =
  | 'workflow.start'
  | 'workflow.input'
  | 'workflow.approve'
  | 'audit.view'
  | 'package.manage';

export interface IdentityProviderConfig {
  id: string;
  type: 'oidc' | 'mock';
  displayName?: string;
  issuer?: string;
  clientId?: string;
  scopes?: string[];
  groupsClaim?: string;
}

export interface RoleMapping {
  provider?: string;
  claim: string;
  value: string;
  role: string;
}

/** Deployment identity configuration mirroring identity.schema.json. */
export interface IdentityConfig {
  providers: IdentityProviderConfig[];
  roleMappings: RoleMapping[];
  permissions?: Record<string, Permission[]>;
  session?: { ttlSeconds?: number };
}

/** Build the audit actor entry for an authenticated principal (verified identity, ADR-0010). */
export function principalActor(principal: Principal): AuditActor {
  return {
    type: 'human',
    id: principal.id,
    provider: principal.provider,
    roles: principal.roles
  };
}
