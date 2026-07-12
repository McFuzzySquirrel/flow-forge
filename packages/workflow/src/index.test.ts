import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';
import { evaluateCondition, WorkflowEngine } from './index.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

function makeEngine() {
  const pkg = loadWorkforcePackage(fixture);
  const provider = new MockModelProvider((req) => {
    const system = req.messages[0]!.content;
    if (system.includes('Planner Agent')) {
      return JSON.stringify({ tasks: [{ title: 'Solve one-step equations', description: 'x + 3 = 10' }] });
    }
    if (system.includes('Curriculum Agent')) {
      return JSON.stringify({ aligned: true, notes: 'Within syllabus' });
    }
    if (system.includes('Assessment Agent')) {
      return JSON.stringify({
        score: 82,
        confidence: 0.9,
        rubricSection: 'Criterion A — Method',
        evidence: [{ source: 'submission', excerpt: 'subtract 3 from both sides' }]
      });
    }
    if (system.includes('Feedback Agent')) {
      return JSON.stringify({ feedback: 'Great method; verify your answers by substitution.' });
    }
    if (system.includes('Teacher Agent')) {
      return JSON.stringify({ consistent: true, notes: 'Score matches feedback' });
    }
    return '{}';
  });
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const agents = new AgentRuntime(pkg, models, new MemoryService(), audit);
  const engine = new WorkflowEngine(agents, audit);
  return { pkg, engine, audit };
}

describe('evaluateCondition', () => {
  it('evaluates comparisons over state', () => {
    expect(evaluateCondition('score >= 50', { score: 82 })).toBe(true);
    expect(evaluateCondition('score < 50', { score: 82 })).toBe(false);
    expect(evaluateCondition('assessment.score == 82', { assessment: { score: 82 } })).toBe(true);
    expect(evaluateCondition('default', {})).toBe(true);
  });
});

describe('WorkflowEngine — Grade7-Maths end-to-end (Phase 1 milestone gate)', () => {
  it('runs the full assignment lifecycle with human pauses and audit trail', async () => {
    const { pkg, engine, audit } = makeEngine();
    const workflow = pkg.workflows.get('assignment')!;

    // 1. starts and pauses for teacher to create the assignment
    let run = await engine.start(workflow);
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'input', role: 'teacher', nodeId: 'create-assignment' });

    // 2. teacher provides the brief → planner + curriculum run → pauses for student
    run = await engine.resume(workflow, run.id, {
      userId: 'teacher-1',
      value: 'Solve one- and two-step linear equations, show working.'
    });
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'input', role: 'student', nodeId: 'student-work' });
    expect(run.state['plan']).toMatchObject({ tasks: expect.any(Array) });

    // 3. student submits → assessment, feedback, consistency check → pauses for approval
    run = await engine.resume(workflow, run.id, {
      userId: 'student-1',
      value: 'x + 3 = 10 → subtract 3 from both sides → x = 7'
    });
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'approval', role: 'teacher', nodeId: 'teacher-approval' });
    expect(run.pending!.subject).toMatchObject({ score: 82 });
    expect(run.state['feedback']).toMatchObject({ feedback: expect.stringContaining('substitution') });

    // 4. teacher approves → workflow completes
    run = await engine.resume(workflow, run.id, { userId: 'teacher-1', approved: true, reason: 'Fair mark' });
    expect(run.status).toBe('completed');

    // audit trail: every step is recorded and the chain is intact
    const actions = audit.all().map((r) => r.action);
    expect(actions).toContain('workflow.start');
    expect(actions).toContain('human.input');
    expect(actions.filter((a) => a === 'agent.step')).toHaveLength(5);
    expect(actions).toContain('human.approval');
    expect(actions).toContain('workflow.complete');
    expect(audit.verify()).toBe(-1);

    // assessment step is fully explainable
    const assessRecord = audit.all().find((r) => r.nodeId === 'assess' && r.action === 'agent.step')!;
    expect(assessRecord.score).toBe(82);
    expect(assessRecord.confidence).toBe(0.9);
    expect(assessRecord.rubricSection).toContain('Criterion A');
    expect(assessRecord.promptVersion).toBeTruthy();
    expect(assessRecord.model).toMatchObject({ provider: 'mock' });
  });

  it('routes rejection back to re-assessment', async () => {
    const { pkg, engine } = makeEngine();
    const workflow = pkg.workflows.get('assignment')!;
    let run = await engine.start(workflow);
    run = await engine.resume(workflow, run.id, { userId: 'teacher-1', value: 'brief' });
    run = await engine.resume(workflow, run.id, { userId: 'student-1', value: 'work' });
    expect(run.pending!.kind).toBe('approval');
    run = await engine.resume(workflow, run.id, { userId: 'teacher-1', approved: false, reason: 'Too lenient' });
    // rejection re-runs assessment → feedback → consistency → pauses at approval again
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending!.nodeId).toBe('teacher-approval');
  });

  it('fails a run when an agent keeps erroring, with retries audited', async () => {
    const pkg = loadWorkforcePackage(fixture);
    const provider = new MockModelProvider(() => {
      throw new Error('model unavailable');
    });
    const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
    const audit = new AuditLog();
    const engine = new WorkflowEngine(new AgentRuntime(pkg, models, new MemoryService(), audit), audit);
    const workflow = pkg.workflows.get('assignment')!;
    let run = await engine.start(workflow);
    run = await engine.resume(workflow, run.id, { userId: 'teacher-1', value: 'brief' });
    expect(run.status).toBe('failed');
    const retries = audit.all().filter((r) => r.action === 'agent.step.retry');
    expect(retries).toHaveLength(2); // maxAttempts: 2 on the plan node
  });
});
