import { describe, expect, it } from 'vitest';
import { schemaNames, validate } from './validate.js';

describe('core schema validation', () => {
  it('exposes all seven schemas', () => {
    expect(schemaNames()).toEqual([
      'workforce-package',
      'agent',
      'skill',
      'persona',
      'workflow',
      'audit-record',
      'identity'
    ]);
  });

  it('validates identity configuration', () => {
    const valid = validate('identity', {
      providers: [
        { id: 'entra', type: 'oidc', issuer: 'https://login.example.com/tenant', clientId: 'abc' }
      ],
      roleMappings: [{ claim: 'groups', value: 'Staff', role: 'teacher' }],
      permissions: { teacher: ['workflow.start', 'workflow.approve'] },
      session: { ttlSeconds: 3600 }
    });
    expect(valid.errors).toEqual([]);

    const invalid = validate('identity', {
      providers: [{ id: 'x', type: 'saml' }],
      roleMappings: []
    });
    expect(invalid.valid).toBe(false);
  });

  it('accepts a minimal valid manifest', () => {
    const result = validate('workforce-package', {
      specVersion: '1.0',
      id: 'dev.flowforge.test',
      name: 'Test',
      version: '1.0.0',
      agents: ['agents/planner/agent.json'],
      workflows: ['workflows/main/workflow.json']
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a manifest without agents', () => {
    const result = validate('workforce-package', {
      specVersion: '1.0',
      id: 'dev.flowforge.test',
      name: 'Test',
      version: '1.0.0',
      workflows: ['w.json']
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('agents');
  });

  it('validates agent definitions', () => {
    expect(
      validate('agent', {
        id: 'assessment',
        name: 'Assessment Agent',
        role: 'Marks work against the rubric',
        model: { tier: 'large' }
      }).valid
    ).toBe(true);
    expect(validate('agent', { id: 'BadId!', name: 'x', role: 'y', model: { tier: 'large' } }).valid).toBe(false);
  });

  it('validates skill frontmatter (Agent Skills format)', () => {
    expect(
      validate('skill', {
        name: 'algebra',
        description: 'Linear equations at Grade 7 level.',
        version: '1.0.0',
        metadata: { displayName: 'Grade 7 Algebra', prompts: ['prompts.md'] }
      }).valid
    ).toBe(true);
    expect(validate('skill', { name: 'Bad Name!', description: 'x' }).valid).toBe(false);
    expect(validate('skill', { name: 'algebra' }).valid).toBe(false);
    expect(validate('skill', { name: 'algebra', description: 'x', prompts: [] }).valid).toBe(false);
  });

  it('validates workflow node discriminators', () => {
    const wf = {
      id: 'main',
      name: 'Main',
      start: 'plan',
      nodes: [
        { id: 'plan', type: 'agent', agent: 'planner', action: 'Plan it', next: 'approve' },
        { id: 'approve', type: 'humanApproval', role: 'teacher', next: 'done' },
        { id: 'done', type: 'end' }
      ]
    };
    expect(validate('workflow', wf).valid).toBe(true);
    const bad = { ...wf, nodes: [{ id: 'plan', type: 'agent', next: 'done' }, { id: 'done', type: 'end' }] };
    expect(validate('workflow', bad).valid).toBe(false);
  });
});
