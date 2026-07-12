import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage, PackageValidationError } from './index.js';

const fixture = fileURLToPath(
  new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url)
);

describe('loadWorkforcePackage', () => {
  it('loads and validates the Grade7-Maths reference package', () => {
    const pkg = loadWorkforcePackage(fixture);
    expect(pkg.manifest.id).toBe('dev.flowforge.grade7-maths');
    expect([...pkg.agents.keys()].sort()).toEqual([
      'assessment',
      'curriculum',
      'feedback',
      'planner',
      'teacher'
    ]);
    expect(pkg.skills.has('maths/algebra')).toBe(true);
    expect(pkg.personas.has('supportive-mentor')).toBe(true);
    expect(pkg.workflows.has('assignment')).toBe(true);
    // system prompts are inlined
    expect(pkg.agents.get('planner')!.systemPrompt).toContain('Planner Agent');
  });

  it('rejects a missing package', () => {
    expect(() => loadWorkforcePackage('/nonexistent')).toThrow();
  });

  it('exposes PackageValidationError with detailed errors', () => {
    expect(PackageValidationError.name).toBe('PackageValidationError');
  });
});
