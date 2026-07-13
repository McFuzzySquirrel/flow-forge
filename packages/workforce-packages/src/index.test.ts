import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkforcePackage, parseSkillFile, PackageValidationError } from './index.js';

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
    expect(pkg.skills.has('algebra')).toBe(true);
    expect(pkg.skills.get('algebra')!.manifest.metadata?.displayName).toBe('Grade 7 Algebra');
    expect(pkg.skills.get('algebra')!.instructions).toContain('one- and two-step linear equations');
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

describe('parseSkillFile', () => {
  function writeSkill(name: string, content: string): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'ff-skill-')), name);
    mkdirSync(dir);
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
