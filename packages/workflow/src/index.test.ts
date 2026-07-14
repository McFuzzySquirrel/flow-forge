import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage } from '@flowforge/packages';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { AgentRuntime, MockModelProvider, ModelRegistry } from '@flowforge/agents';
import type { Principal } from '@flowforge/core';
import { AuthorizationError, evaluateCondition, WorkflowEngine } from './index.js';

const teacher: Principal = {
  id: 'teacher-1',
  displayName: 'Ms Patel',
  provider: 'mock',
  roles: ['teacher']
};
const teacher2: Principal = { id: 'teacher-2', provider: 'mock', roles: ['teacher'] };
const student: Principal = { id: 'student-1', displayName: 'Alex', provider: 'mock', roles: ['student'] };
const student2: Principal = { id: 'student-2', provider: 'mock', roles: ['student'] };

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
      principal: teacher,
      value: 'Solve one- and two-step linear equations, show working.'
    });
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'input', role: 'student', nodeId: 'student-work' });
    expect(run.state['plan']).toMatchObject({ tasks: expect.any(Array) });

    // 3. student submits → assessment, feedback, consistency check → pauses for approval
    run = await engine.resume(workflow, run.id, {
      principal: student,
      value: 'x + 3 = 10 → subtract 3 from both sides → x = 7'
    });
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'approval', role: 'teacher', nodeId: 'teacher-approval' });
    expect(run.pending!.subject).toMatchObject({ score: 82 });
    expect(run.state['feedback']).toMatchObject({ feedback: expect.stringContaining('substitution') });

    // 4. teacher approves → workflow completes
    run = await engine.resume(workflow, run.id, { principal: teacher, approved: true, reason: 'Fair mark' });
    expect(run.status).toBe('completed');

    // audit trail: every step is recorded and the chain is intact
    const actions = audit.all().map((r) => r.action);
    expect(actions).toContain('workflow.start');
    expect(actions).toContain('human.input');
    expect(actions.filter((a) => a === 'agent.step')).toHaveLength(5);
    expect(actions).toContain('human.approval');
    expect(actions).toContain('workflow.complete');
    expect(audit.verify()).toBe(-1);

    // human actions carry verified identity (provider + roles) in the audit trail
    const approvalRecord = audit.all().find((r) => r.action === 'human.approval')!;
    expect(approvalRecord.actor).toMatchObject({ type: 'human', id: 'teacher-1', provider: 'mock', roles: ['teacher'] });

    // assessment step is fully explainable
    const assessRecord = audit.all().find((r) => r.nodeId === 'assess' && r.action === 'agent.step')!;
    expect(assessRecord.score).toBe(82);
    expect(assessRecord.confidence).toBe(0.9);
    expect(assessRecord.rubricSection).toContain('Criterion A');
    expect(assessRecord.promptVersion).toBeTruthy();
    expect(assessRecord.model).toMatchObject({ provider: 'mock' });
  });

  it('routes rejection back to the student to revise and resubmit', async () => {
    const { pkg, engine } = makeEngine();
    const workflow = pkg.workflows.get('assignment')!;
    let run = await engine.start(workflow);
    run = await engine.resume(workflow, run.id, { principal: teacher, value: 'brief' });
    run = await engine.resume(workflow, run.id, { principal: student, value: 'work' });
    expect(run.pending!.kind).toBe('approval');
    run = await engine.resume(workflow, run.id, { principal: teacher, approved: false, reason: 'Too lenient' });
    // rejection returns to the student to make changes and resubmit
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending).toMatchObject({ kind: 'input', role: 'student', nodeId: 'student-work' });
    // resubmission re-runs assessment → feedback → consistency → pauses at approval again
    run = await engine.resume(workflow, run.id, { principal: student, value: 'revised work' });
    expect(run.status).toBe('waitingForHuman');
    expect(run.pending!.nodeId).toBe('teacher-approval');
    run = await engine.resume(workflow, run.id, { principal: teacher, approved: true, reason: 'Fair now' });
    expect(run.status).toBe('completed');
  });

  it('denies acting outside your role: a student cannot approve, a teacher cannot submit student work', async () => {
    const { pkg, engine, audit } = makeEngine();
    const workflow = pkg.workflows.get('assignment')!;
    let run = await engine.start(workflow);
    run = await engine.resume(workflow, run.id, { principal: teacher, value: 'brief' });

    // teacher cannot submit student work
    await expect(
      engine.resume(workflow, run.id, { principal: teacher, value: 'not my homework' })
    ).rejects.toThrow(AuthorizationError);

    run = await engine.resume(workflow, run.id, { principal: student, value: 'work' });

    // student cannot approve their own assessment
    await expect(
      engine.resume(workflow, run.id, { principal: student, approved: true, reason: 'looks fine to me' })
    ).rejects.toThrow(AuthorizationError);

    // both denials are audited and the run is untouched
    const denials = audit.all().filter((r) => r.action === 'workflow.authorization.denied');
    expect(denials).toHaveLength(2);
    expect(denials[0]!.actor).toMatchObject({ type: 'human', id: 'teacher-1' });
    expect(denials[1]!.actor).toMatchObject({ type: 'human', id: 'student-1' });
    expect(audit.verify()).toBe(-1);
    expect(engine.getRun(run.id)!.pending!.nodeId).toBe('teacher-approval');

    // the rightful teacher can still approve
    run = await engine.resume(workflow, run.id, { principal: teacher, approved: true, reason: 'Fair' });
    expect(run.status).toBe('completed');
  });

  it('binds roles to the first participant: another student cannot resubmit, another teacher cannot approve', async () => {
    const { pkg, engine } = makeEngine();
    const workflow = pkg.workflows.get('assignment')!;
    let run = await engine.start(workflow);
    run = await engine.resume(workflow, run.id, { principal: teacher, value: 'brief' });
    run = await engine.resume(workflow, run.id, { principal: student, value: 'work' });

    // a different teacher cannot take over the approval
    await expect(
      engine.resume(workflow, run.id, { principal: teacher2, approved: true, reason: 'I approve' })
    ).rejects.toThrow(AuthorizationError);

    run = await engine.resume(workflow, run.id, { principal: teacher, approved: false, reason: 'Revise' });
    expect(run.pending!.nodeId).toBe('student-work');

    // a different student cannot resubmit in the original student's place
    await expect(
      engine.resume(workflow, run.id, { principal: student2, value: 'my work instead' })
    ).rejects.toThrow(AuthorizationError);

    run = await engine.resume(workflow, run.id, { principal: student, value: 'revised work' });
    run = await engine.resume(workflow, run.id, { principal: teacher, approved: true, reason: 'Fair' });
    expect(run.status).toBe('completed');
    expect(run.participants).toEqual({ teacher: 'teacher-1', student: 'student-1' });
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
    run = await engine.resume(workflow, run.id, { principal: teacher, value: 'brief' });
    expect(run.status).toBe('failed');
    const retries = audit.all().filter((r) => r.action === 'agent.step.retry');
    expect(retries).toHaveLength(2); // maxAttempts: 2 on the plan node
  });
});
