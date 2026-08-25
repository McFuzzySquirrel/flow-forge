/**
 * Workforce package packaging — the .workforce distribution format (Phase 4.1).
 *
 *   pack   — directory → deterministic, optionally signed .workforce archive
 *   unpack — .workforce archive → directory
 *   verify — integrity (hash manifest) + authorship (Ed25519 signature)
 *
 * The archive is a deterministic STORE-method ZIP whose entry order is sorted
 * and timestamps pinned, plus a hash manifest of every file and an optional
 * Ed25519 signature over that manifest. Building twice from the same source
 * produces identical bytes.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadWorkforcePackage } from '@flowforge/packages';
import { canonicalJson } from './canonical.js';
import { createZip, readZip, type ZipEntry } from './zip.js';
import {
  generateSigningKeypair,
  publicKeyFingerprint,
  signBytes,
  verifySignature,
  type SigningKeypair
} from './signing.js';
import {
  MANIFEST_FILE_NAME,
  MANIFEST_FORMAT_VERSION,
  checkEngineCompatibility,
  signedManifestBytes,
  type FileHashEntry,
  type WorkforceManifest,
  type WorkforceManifestPayload
} from './manifest.js';

export * from './zip.js';
export * from './signing.js';
export * from './manifest.js';
export { canonicalJson };

export interface PackOptions {
  /** If given, the archive is signed with this keypair. */
  signingKey?: SigningKeypair;
  /** Human-readable publisher name recorded in the signature block. */
  publisher?: string;
  /** Skip pre-pack validation (schema + cross-references). */
  skipValidation?: boolean;
}

export interface PackResult {
  archivePath: string;
  packageId: string;
  packageVersion: string;
  signed: boolean;
  signerFingerprint?: string;
  fileCount: number;
}

export interface VerifyResult {
  valid: boolean;
  /** Human-readable reasons the archive failed validation (empty when valid). */
  errors: string[];
  packageId?: string;
  packageVersion?: string;
  signed: boolean;
  signerFingerprint?: string;
  signatureValid?: boolean;
  /** Whether every file in the archive matches the manifest hashes. */
  hashesIntact: boolean;
  engineCompatible?: boolean;
  engineReason?: string;
}

/** Recursively collect every file under root, sorted, as forward-slash rel paths. */
export function collectPackageFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(relative(rootDir, full).split('\\').join('/'));
      }
    }
  };
  walk(rootDir);
  files.sort();
  return files;
}

/** Pack a .workforce directory into a deterministic archive file. */
export function packWorkforce(packageDir: string, outputPath: string, options: PackOptions = {}): PackResult {
  const rootDir = resolve(packageDir);
  if (!options.skipValidation) {
    loadWorkforcePackage(rootDir); // throws PackageValidationError on invalid
  }
  const manifestJson = JSON.parse(readFileSync(join(rootDir, 'workforce.json'), 'utf8')) as {
    id: string;
    version: string;
  };

  const relPaths = collectPackageFiles(rootDir);
  const files: FileHashEntry[] = [];
  const entries: ZipEntry[] = [];
  for (const relPath of relPaths) {
    const data = readFileSync(join(rootDir, relPath));
    files.push({ path: relPath, sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
    entries.push({ name: relPath, data });
  }

  const payload: WorkforceManifestPayload = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    packageId: manifestJson.id,
    packageVersion: manifestJson.version,
    files
  };

  let signature: WorkforceManifest['signature'];
  if (options.signingKey) {
    const { privateKey, publicKey } = options.signingKey;
    const sig = signBytes(signedManifestBytes(payload), privateKey);
    signature = {
      algorithm: 'ed25519',
      publisher: options.publisher,
      signerFingerprint: publicKeyFingerprint(publicKey),
      publicKey,
      signature: sig
    };
  }

  const manifest: WorkforceManifest = signature ? { ...payload, signature } : payload;
  entries.push({ name: MANIFEST_FILE_NAME, data: Buffer.from(canonicalJson(manifest), 'utf8') });
  writeFileSync(outputPath, createZip(entries));

  return {
    archivePath: outputPath,
    packageId: manifestJson.id,
    packageVersion: manifestJson.version,
    signed: Boolean(signature),
    signerFingerprint: signature?.signerFingerprint,
    fileCount: files.length
  };
}

/** Unpack a .workforce archive into a directory. Guards against path traversal. */
export function unpackWorkforce(archivePath: string, destDir: string): string[] {
  const entries = readZip(readFileSync(archivePath));
  mkdirSync(destDir, { recursive: true });
  const written: string[] = [];
  for (const [name, data] of entries) {
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`Refusing to unpack unsafe entry path '${name}'`);
    }
    const outPath = join(destDir, name);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, data);
    written.push(name);
  }
  return written;
}

/**
 * Verify an archive: hash manifest integrity, optional Ed25519 signature
 * (authorship), and engine-version compatibility against the current engine.
 */
export function verifyWorkforceArchive(
  archivePath: string,
  options: { engineVersion?: string } = {}
): VerifyResult {
  const errors: string[] = [];
  let entries: Map<string, Uint8Array>;
  try {
    entries = readZip(readFileSync(archivePath));
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      signed: false,
      hashesIntact: false
    };
  }

  const manifestEntry = entries.get(MANIFEST_FILE_NAME);
  if (!manifestEntry) {
    return {
      valid: false,
      errors: ['Archive is missing the hash manifest (workforce.manifest.json)'],
      signed: false,
      hashesIntact: false
    };
  }

  let manifest: WorkforceManifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestEntry).toString('utf8')) as WorkforceManifest;
  } catch {
    return {
      valid: false,
      errors: ['Hash manifest is not valid JSON'],
      signed: false,
      hashesIntact: false
    };
  }

  const signed = Boolean(manifest.signature);
  let signatureValid: boolean | undefined;
  if (signed) {
    const { signature, publicKey } = manifest.signature!;
    const payload: WorkforceManifestPayload = {
      formatVersion: manifest.formatVersion,
      packageId: manifest.packageId,
      packageVersion: manifest.packageVersion,
      files: manifest.files
    };
    signatureValid = verifySignature(signedManifestBytes(payload), signature, publicKey);
    if (!signatureValid) errors.push('Signature verification FAILED — authorship or integrity not proven');
    if (publicKeyFingerprint(publicKey) !== manifest.signature!.signerFingerprint) {
      errors.push('Signature signerFingerprint does not match the embedded public key');
    }
  }

  // Hash manifest integrity.
  const expected = new Map(manifest.files.map((f) => [f.path, f] as const));
  let hashesIntact = true;
  const entryNames = [...entries.keys()].filter((name) => name !== MANIFEST_FILE_NAME);
  for (const name of entryNames) {
    const expectedEntry = expected.get(name);
    if (!expectedEntry) {
      hashesIntact = false;
      errors.push(`Archive contains '${name}' not listed in the manifest`);
      continue;
    }
    const data = entries.get(name)!;
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (actualHash !== expectedEntry.sha256 || data.length !== expectedEntry.size) {
      hashesIntact = false;
      errors.push(`File '${name}' does not match its manifest hash`);
    }
  }
  for (const path of expected.keys()) {
    if (!entries.has(path)) {
      hashesIntact = false;
      errors.push(`Manifest lists '${path}' but the archive does not contain it`);
    }
  }

  // Engine compatibility (best-effort: only when an engine version is provided).
  let engineCompatible: boolean | undefined;
  let engineReason: string | undefined;
  if (options.engineVersion) {
    let declared: string | undefined;
    try {
      const workforceEntry = entries.get('workforce.json');
      if (workforceEntry) {
        declared = (JSON.parse(Buffer.from(workforceEntry).toString('utf8')) as { engineVersion?: string }).engineVersion;
      }
    } catch {
      // fall through — treated as no declared range below
    }
    const result = checkEngineCompatibility(declared, options.engineVersion);
    engineCompatible = result.compatible;
    engineReason = result.reason;
    if (!result.compatible) errors.push(result.reason ?? 'engine compatibility check failed');
  }

  return {
    valid: errors.length === 0,
    errors,
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    signed,
    signerFingerprint: manifest.signature?.signerFingerprint,
    signatureValid,
    hashesIntact,
    engineCompatible,
    engineReason
  };
}

/** Default output path for a packed archive: `<package-id>-<version>.workforce` in cwd. */
export function defaultArchivePath(packageDir: string): string {
  const pkg = loadWorkforcePackage(packageDir);
  return join(process.cwd(), `${pkg.manifest.id}-${pkg.manifest.version}.workforce`);
}

export { generateSigningKeypair };
