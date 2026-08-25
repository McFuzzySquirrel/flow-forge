import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage } from '@flowforge/packages';
import { MockModelProvider, ModelRegistry, AgentRuntime, type ModelProvider } from '@flowforge/agents';
import { AuditLog } from '@flowforge/audit';
import { MemoryService } from '@flowforge/memory';
import { WorkflowEngine, EmbeddedWorkflowRunner } from './index.js';
import { devPrincipal, runConformanceSuite } from './conformance.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

function makeEngine() {
  const pkg = loadWorkforcePackage(fixture);
  const provider: ModelProvider = new MockModelProvider(() =>
    JSON.stringify({ note: 'mock', score: 80, confidence: 0.9 })
  );
  const models = new ModelRegistry().set('small', provider).set('medium', provider).set('large', provider);
  const audit = new AuditLog();
  const engine = new WorkflowEngine(new AgentRuntime(pkg, models, new MemoryService(), audit), audit);
  return { engine, audit };
}

describe('runner conformance suite (embedded runner)', () => {
  it('drives the Grade7 assignment workflow through the reference scenario', async () => {
    const pkg = loadWorkforcePackage(fixture);
    const workflow = pkg.workflows.get('assignment')!;
    const { engine, audit } = makeEngine();
    const runner = new EmbeddedWorkflowRunner(engine, workflow);

    const result = await runConformanceSuite(
      runner,
      workflow,
      [
        {
          role: 'teacher',
          principal: devPrincipal('teacher'),
          response: { value: 'Solve one- and two-step linear equations, show working.' },
          expectState: { assignment: 'Solve one- and two-step linear equations, show working.' }
        },
        {
          role: 'student',
          principal: devPrincipal('student'),
          response: { value: 'x + 3 = 10; x = 7' },
          expectState: { submission: 'x + 3 = 10; x = 7' }
        },
        {
          role: 'teacher',
          principal: devPrincipal('teacher'),
          response: { approved: true, reason: 'Correct method shown' }
        }
      ],
      audit
    );

    expect(result.stepsConsumed).toBe(3);
    expect(result.run.status).toBe('completed');
    expect(result.run.state.assessment).toBeDefined();
    expect(result.audit.all().length).toBeGreaterThan(0);
  });
});
