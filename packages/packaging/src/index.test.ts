import { describe, expect, it } from 'vitest';
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkforcePackage, PackageValidationError } from '@flowforge/packages';
import { createZip, readZip } from './zip.js';
import { canonicalJson } from './canonical.js';
import { generateSigningKeypair } from './signing.js';
import { checkEngineCompatibility } from './manifest.js';
import {
  packWorkforce,
  unpackWorkforce,
  verifyWorkforceArchive,
  defaultArchivePath
} from './index.js';

const fixture = fileURLToPath(new URL('../../../fixtures/Grade7-Maths.workforce', import.meta.url));

function signWith(privateKeyPem: string, data: Buffer): string {
  return sign(null, data, createPrivateKey(privateKeyPem)).toString('base64');
}
function verifyWith(publicKeyPem: string, data: Buffer, signature: string): boolean {
  return verify(null, data, createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
}

describe('deterministic ZIP', () => {
  it('round-trips entries exactly', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('alpha') },
      { name: 'dir/b.json', data: Buffer.from('{"x":1}') }
    ];
    const zip = createZip(entries);
    const read = readZip(zip);
    expect([...read.get('a.txt')!]).toEqual([...Buffer.from('alpha')]);
    expect([...read.get('dir/b.json')!]).toEqual([...Buffer.from('{"x":1}')]);
  });

  it('produces identical bytes for identical input (fixed timestamps, sorted order)', () => {
    const a = createZip([
      { name: 'b.txt', data: Buffer.from('x') },
      { name: 'a.txt', data: Buffer.from('y') }
    ]);
    const b = createZip([
      { name: 'a.txt', data: Buffer.from('y') },
      { name: 'b.txt', data: Buffer.from('x') }
    ]);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it('rejects a corrupted archive', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.from('payload') }]);
    const corrupted = Buffer.from(zip);
    corrupted[40] ^= 0xff; // corrupt a byte inside the first entry's data → CRC mismatch
    expect(() => readZip(corrupted)).toThrow();
  });
});

describe('canonical JSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: [1, 2] } })).toBe(
      canonicalJson({ a: { c: [1, 2], d: true }, b: 1 })
    );
  });
});

describe('signing keys', () => {
  it('generates a keypair and verifies a signature', () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const data = Buffer.from('hello world');
    const signature = signWith(privateKey, data);
    expect(verifyWith(publicKey, data, signature)).toBe(true);
    expect(verifyWith(publicKey, Buffer.from('tampered'), signature)).toBe(false);
  });
});

describe('engine compatibility', () => {
  it('accepts a satisfying range and refuses an unsatisfying one', () => {
    expect(checkEngineCompatibility(undefined, '0.1.0').compatible).toBe(true);
    expect(checkEngineCompatibility('>=0.1.0', '0.1.0').compatible).toBe(true);
    expect(checkEngineCompatibility('^0.1.0', '0.1.0').compatible).toBe(true);
    expect(checkEngineCompatibility('<0.1.0', '0.1.0').compatible).toBe(false);
    expect(checkEngineCompatibility('>=1.0.0', '0.1.0').compatible).toBe(false);
    expect(checkEngineCompatibility('garbage range', '0.1.0').compatible).toBe(false);
  });
});

// Small local helpers to avoid importing the full index (which pulls in fs walks).

// ---------------------------------------------------------------------------
// pack / unpack / verify round-trip against the reference fixture
// ---------------------------------------------------------------------------


describe('pack / unpack / verify', () => {
  it('round-trips a package directory through an archive exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const archive = join(dir, 'pkg.workforce');
      packWorkforce(fixture, archive);
      const unpacked = join(dir, 'unpacked');
      unpackWorkforce(archive, unpacked);

      const original = loadWorkforcePackage(fixture);
      const restored = loadWorkforcePackage(unpacked);
      expect(restored.manifest).toEqual(original.manifest);
      expect(restored.agents.size).toBe(original.agents.size);
      expect(restored.workflows.size).toBe(original.workflows.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic: packing twice yields identical bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const a = join(dir, 'a.workforce');
      const b = join(dir, 'b.workforce');
      packWorkforce(fixture, a);
      packWorkforce(fixture, b);
      expect(readFileSync(a)).toEqual(readFileSync(b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies an unsigned archive as intact but unsigned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const archive = join(dir, 'pkg.workforce');
      packWorkforce(fixture, archive);
      const result = verifyWorkforceArchive(archive);
      expect(result.valid).toBe(true);
      expect(result.hashesIntact).toBe(true);
      expect(result.signed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a signed archive and rejects a tampered one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const keypair = generateSigningKeypair();
      const archive = join(dir, 'signed.workforce');
      const packed = packWorkforce(fixture, archive, { signingKey: keypair, publisher: 'FlowForge Team' });
      expect(packed.signed).toBe(true);
      expect(packed.signerFingerprint).toBeTruthy();

      const ok = verifyWorkforceArchive(archive);
      expect(ok.valid).toBe(true);
      expect(ok.signed).toBe(true);
      expect(ok.signatureValid).toBe(true);
      expect(ok.signerFingerprint).toBe(packed.signerFingerprint);

      // Tamper: replace an archive entry's bytes in place by re-packing with a modified file.
      const unpacked = join(dir, 'unpacked');
      unpackWorkforce(archive, unpacked);
      const agentPath = join(unpacked, 'agents/planner/prompt.md');
      writeFileSync(agentPath, readFileSync(agentPath) + '\n// tampered\n');
      const tampered = join(dir, 'tampered.workforce');
      packWorkforce(unpacked, tampered, { signingKey: keypair });

      const bad = verifyWorkforceArchive(tampered);
      expect(bad.hashesIntact).toBe(false);
      expect(bad.valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to unpack path-traversal entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const evil = join(dir, 'evil.workforce');
      const zip = createZip([{ name: '../escape.txt', data: Buffer.from('boom') }]);
      writeFileSync(evil, zip);
      expect(() => unpackWorkforce(evil, join(dir, 'out'))).toThrow(/unsafe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pack refuses an invalid package by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const bad = join(dir, 'badpkg');
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, 'workforce.json'), JSON.stringify({ id: 'x', version: '1.0.0' }));
      expect(() => packWorkforce(bad, join(dir, 'x.workforce'))).toThrow(PackageValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks engine compatibility during verify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const archive = join(dir, 'pkg.workforce');
      packWorkforce(fixture, archive);
      const ok = verifyWorkforceArchive(archive, { engineVersion: '0.1.0' });
      expect(ok.engineCompatible).toBe(true);

      // A package that demands a newer engine is refused.
      const custom = join(dir, 'custompkg');
      unpackWorkforce(archive, custom);
      const manifestPath = join(custom, 'workforce.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.engineVersion = '>=2.0.0';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const customArchive = join(dir, 'custom.workforce');
      packWorkforce(custom, customArchive);
      const refused = verifyWorkforceArchive(customArchive, { engineVersion: '0.1.0' });
      expect(refused.engineCompatible).toBe(false);
      expect(refused.valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives a default archive path from the package manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowforge-pack-'));
    try {
      const pkgDir = join(dir, 'pkg');
      mkdirSync(join(pkgDir, 'agents', 'a'), { recursive: true });
      mkdirSync(join(pkgDir, 'workflows'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'workforce.json'),
        JSON.stringify({
          specVersion: '1.0',
          id: 'dev.flowforge.test',
          name: 'Test',
          version: '1.2.3',
          agents: ['agents/a/agent.json'],
          workflows: ['workflows/w.json']
        })
      );
      writeFileSync(
        join(pkgDir, 'agents/a/agent.json'),
        JSON.stringify({ id: 'a', name: 'A', role: 'does things', model: { tier: 'small' } })
      );
      writeFileSync(
        join(pkgDir, 'workflows/w.json'),
        JSON.stringify({ id: 'w', name: 'W', start: 'e', nodes: [{ id: 'e', type: 'end' }] })
      );
      const path = defaultArchivePath(pkgDir);
      expect(path.endsWith('dev.flowforge.test-1.2.3.workforce')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
