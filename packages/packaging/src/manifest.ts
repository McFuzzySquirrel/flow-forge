/**
 * Archive manifest: a hash manifest of every file in a .workforce archive
 * plus the Ed25519 signature over it (Phase 4.1.1/4.1.3). The hash proves
 * integrity (nothing changed); the signature proves authorship (who published
 * it). It does not prove the content is good — signing is not review.
 */
import { validRange, satisfies } from 'semver';

export const MANIFEST_FILE_NAME = 'workforce.manifest.json';
export const MANIFEST_FORMAT_VERSION = 1;

export interface FileHashEntry {
  /** Forward-slash path relative to the package root. */
  path: string;
  /** SHA-256 hex digest of the file bytes. */
  sha256: string;
  /** Byte length of the file. */
  size: number;
}

export interface WorkforceManifestSignature {
  algorithm: 'ed25519';
  /** Optional human-readable publisher name (not a security boundary). */
  publisher?: string;
  /** First 40 hex chars of SHA-256 over the SPKI DER. */
  signerFingerprint: string;
  /** SPKI PEM public key — lets anyone verify offline. */
  publicKey: string;
  /** Base64 Ed25519 signature over the canonical manifest minus this block. */
  signature: string;
}

/** The signed portion of the manifest — everything except the signature block. */
export interface WorkforceManifestPayload {
  formatVersion: number;
  packageId: string;
  packageVersion: string;
  files: FileHashEntry[];
}

export interface WorkforceManifest extends WorkforceManifestPayload {
  /** Present only when the publisher signed the archive. */
  signature?: WorkforceManifestSignature;
}

/** Serialise exactly the bytes that are signed (payload, canonically). */
export function signedManifestBytes(payload: WorkforceManifestPayload): Buffer {
  return Buffer.from(canonicalJson(payload), 'utf8');
}

/**
 * Check whether a package's declared `engineVersion` range is satisfied by the
 * running engine. A missing range is treated as "compatible with anything".
 * An unparseable range is a hard incompatibility (fail closed).
 */
export function checkEngineCompatibility(
  range: string | undefined,
  engineVersion: string
): { compatible: boolean; reason?: string } {
  if (range === undefined) return { compatible: true };
  if (!validRange(range)) {
    return { compatible: false, reason: `'${range}' is not a valid semver range` };
  }
  if (!satisfies(engineVersion, range)) {
    return {
      compatible: false,
      reason: `engine ${engineVersion} does not satisfy package requirement '${range}'`
    };
  }
  return { compatible: true };
}

import { canonicalJson } from './canonical.js';
