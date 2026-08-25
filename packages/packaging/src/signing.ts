/**
 * Ed25519 signing for workforce packages (Phase 4.1.3). Uses Node's built-in
 * crypto — no external signing library. Ed25519 is deterministic (no random
 * nonce), so signing the same bytes twice yields the same signature, which is
 * required for reproducible archives.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto';

export interface SigningKeypair {
  /** PKCS8 PEM private key. */
  privateKey: string;
  /** SPKI PEM public key. */
  publicKey: string;
}

export function generateSigningKeypair(): SigningKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  return { privateKey, publicKey };
}

/** Derive the public key for a private key PEM (e.g. when the user only supplies --signing-key). */
export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Short, human-readable identity for a public key: the first 40 hex chars of
 * the SHA-256 of the SPKI DER. Shown to users so they can confirm who signed.
 */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('hex').slice(0, 40);
}

/** Sign raw bytes with an Ed25519 private key; returns a base64 signature. */
export function signBytes(data: Uint8Array, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(data), key).toString('base64');
}

/** Verify a base64 Ed25519 signature over raw bytes against a public key PEM. */
export function verifySignature(data: Uint8Array, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(data), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
