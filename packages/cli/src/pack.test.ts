import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packCommand, unpackCommand, verifyCommand } from './index.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

function capture(fn: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  console.warn = (...a: unknown[]) => err.push(a.join(' '));
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    console.log = origOut;
    console.error = origErr;
    console.warn = origWarn;
  }
}

describe('CLI pack/unpack/verify (Phase 4.1)', () => {
  it('packs, verifies and unpacks the reference package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-cli-'));
    try {
      const archive = join(dir, 'pkg.workforce');
      const packed = capture(() => packCommand(fixture, { outputPath: archive }));
      expect(packed.code).toBe(0);
      expect(packed.out.join('\n')).toContain('Packed');
      expect(readFileSync(archive).length).toBeGreaterThan(0);

      const verified = capture(() => verifyCommand(archive));
      expect(verified.code).toBe(0);
      expect([...verified.out, ...verified.err].join('\n')).toContain('valid');
      expect([...verified.out, ...verified.err].join('\n')).toContain('unsigned');

      const unpacked = join(dir, 'unpacked');
      const unpackedResult = capture(() => unpackCommand(archive, { outputDir: unpacked }));
      expect(unpackedResult.code).toBe(0);
      expect(unpackedResult.out.join('\n')).toContain('Unpacked');
      expect(readFileSync(join(unpacked, 'workforce.json'), 'utf8')).toContain('grade7-maths');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify fails loudly on a corrupt archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-cli-'));
    try {
      const archive = join(dir, 'pkg.workforce');
      packCommand(fixture, { outputPath: archive });
      const bytes = readFileSync(archive);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff; // corrupt a byte in file data / central dir
      writeFileSync(archive, bytes);
      const verified = capture(() => verifyCommand(archive));
      expect(verified.code).toBe(1);
      expect(verified.err.join('\n')).toContain('NOT valid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify reports an invalid package directory for pack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-cli-'));
    try {
      const bad = join(dir, 'badpkg');
      mkdirSync(bad);
      writeFileSync(join(bad, 'workforce.json'), JSON.stringify({ id: 'x' }));
      const packed = capture(() => packCommand(bad, { outputPath: join(dir, 'x.workforce') }));
      expect(packed.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
