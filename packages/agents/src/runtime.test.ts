import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry } from './index.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

function makeRuntime(responder: (systemPrompt: string) => string) {
  const pkg = loadWorkforcePackage(fixture);
  const provider = new MockModelProvider((req) => responder(req.messages[0]!.content));
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const memory = new MemoryService();
  return { runtime: new AgentRuntime(pkg, models, memory, audit), audit, memory };
}

describe('AgentRuntime', () => {
  it('runs a step, parses structured output and emits an audit record', async () => {
    const { runtime, audit } = makeRuntime(() => JSON.stringify({ score: 82, confidence: 0.9 }));
    const result = await runtime.step({
      agentId: 'assessment',
      action: 'Mark the submission',
      inputs: { submission: 'x = 4' },
      workflowRunId: 'run-1',
      nodeId: 'assess'
    });
    expect(result.output).toEqual({ score: 82, confidence: 0.9 });
    const records = audit.all();
    expect(records).toHaveLength(1);
    expect(records[0]!.actor).toEqual({ type: 'agent', id: 'assessment', persona: 'strict-examiner' });
    expect(records[0]!.score).toBe(82);
    expect(records[0]!.promptVersion).toHaveLength(12);
    expect(audit.verify()).toBe(-1);
  });

  it('applies persona overlays to the system prompt', async () => {
    let seenPrompt = '';
    const { runtime } = makeRuntime((systemPrompt) => {
      seenPrompt = systemPrompt;
      return '{}';
    });
    await runtime.step({
      agentId: 'assessment',
      action: 'Mark',
      inputs: {},
      personaId: 'supportive-mentor'
    });
    expect(seenPrompt).toContain('Supportive Mentor');
    expect(seenPrompt).not.toContain('Strict Examiner');
  });

  it('includes SKILL.md instructions in the system prompt', async () => {
    let seenPrompt = '';
    const { runtime } = makeRuntime((systemPrompt) => {
      seenPrompt = systemPrompt;
      return '{}';
    });
    await runtime.step({ agentId: 'assessment', action: 'Mark', inputs: {} });
    expect(seenPrompt).toContain('Skill (Grade 7 Algebra)');
    expect(seenPrompt).toContain('one- and two-step linear equations');
  });

  it('includes recalled memory as evidence', async () => {
    const { runtime, memory, audit } = makeRuntime(() => '{}');
    await memory.remember(
      'dev.flowforge.grade7-maths/assessment',
      'Grading exemplar: two-step equations require verification'
    );
    await runtime.step({
      agentId: 'assessment',
      action: 'Mark two-step equations submission with verification',
      inputs: {}
    });
    const record = audit.all()[0]!;
    expect(record.evidence!.length).toBeGreaterThan(0);
    expect(record.evidence![0]!.source).toContain('memory:dev.flowforge.grade7-maths/assessment');
  });

  it('rejects unknown agents', async () => {
    const { runtime } = makeRuntime(() => '{}');
    await expect(runtime.step({ agentId: 'nope', action: 'x', inputs: {} })).rejects.toThrow(
      "Unknown agent 'nope'"
    );
  });
});
