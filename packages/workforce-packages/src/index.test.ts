import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkforcePackage, parseSkillFile, PackageValidationError } from './index.js';

const fixture = fileURLToPath(
  new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url)
);
const scratchRoot = fileURLToPath(new URL('../../../.test-artifacts/workforce-packages/', import.meta.url));

describe('loadWorkforcePackage', () => {
  it('loads and validates the Grade7-Maths reference package', () => {
    const pkg = loadWorkforcePackage(fixture);
    expect(pkg.manifest.id).toBe('dev.flowforge.grade7-maths');
    expect([...pkg.agents.keys()].sort()).toEqual([
      'assessment',
      'coach',
      'curriculum',
      'feedback',
      'planner',
      'reflection',
      'teacher'
    ]);
    expect(pkg.skills.has('algebra')).toBe(true);
    expect(pkg.skills.has('coaching')).toBe(true);
    expect(pkg.skills.has('reflection')).toBe(true);
    expect(pkg.skills.get('algebra')!.manifest.metadata?.displayName).toBe('Grade 7 Algebra');
    expect(pkg.skills.get('algebra')!.instructions).toContain('one- and two-step linear equations');
    expect(pkg.personas.has('supportive-mentor')).toBe(true);
    expect(pkg.workflows.has('assignment')).toBe(true);
    expect(pkg.workflows.has('revision')).toBe(true);
    // system prompts are inlined
    expect(pkg.agents.get('planner')!.systemPrompt).toContain('Planner Agent');
    expect(pkg.agents.get('coach')!.systemPrompt).toContain('Learning Coach');
  });

  it('rejects a missing package', () => {
    expect(() => loadWorkforcePackage('/nonexistent')).toThrow();
  });

  it('exposes PackageValidationError with detailed errors', () => {
    expect(PackageValidationError.name).toBe('PackageValidationError');
  });
});

describe('parseSkillFile', () => {
  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  function writeSkill(name: string, content: string): string {
    const dir = join(scratchRoot, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, content);
    return path;
  }

  it('parses frontmatter and instructions body', () => {
    const path = writeSkill(
      'algebra',
      '---\nname: algebra\ndescription: Linear equations.\n---\n\n# Instructions\n\nShow working.\n'
    );
    const skill = parseSkillFile(path, 'SKILL.md');
    expect(skill.manifest.name).toBe('algebra');
    expect(skill.instructions).toContain('Show working.');
  });

  it('rejects a file without frontmatter', () => {
    const path = writeSkill('algebra', '# Just markdown\n');
    expect(() => parseSkillFile(path, 'SKILL.md')).toThrow(PackageValidationError);
  });

  it('rejects frontmatter that fails the skill schema', () => {
    const path = writeSkill('algebra', '---\nname: algebra\n---\nbody\n');
    expect(() => parseSkillFile(path, 'SKILL.md')).toThrow(/description/);
  });

  it("rejects a name that doesn't match the folder name", () => {
    const path = writeSkill('algebra', '---\nname: geometry\ndescription: x\n---\nbody\n');
    expect(() => parseSkillFile(path, 'SKILL.md')).toThrow(/must match the skill folder name/);
  });
});
