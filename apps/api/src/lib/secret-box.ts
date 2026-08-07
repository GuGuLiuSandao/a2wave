/**
 * Symmetric encryption for secrets persisted in the `settings` table
 * (today: the OIDC client_secret, `sso.oidcClientSecretEnc`).
 *
 * AES-256-GCM with a key derived from AUTH_SECRET via HKDF-SHA256. The salt and
 * info strings are part of the on-disk format: changing either re-derives a
 * different key and makes every stored ciphertext undecryptable, so they are
 * fixed constants rather than configuration.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from '../env.js'

const AES_KEY_BYTES = 32
const AES_NONCE_BYTES = 12
const AES_TAG_BYTES = 16
/**
 * Historical values, kept verbatim. These strings were introduced by the gateway
 * JWT signer that originally owned this code; the signer is gone but the derived
 * key must stay identical, otherwise secrets encrypted by older versions (an
 * OIDC client_secret saved before the upgrade) can no longer be read back.
 */
const HKDF_SALT = 'a2wave-jwt-signer-v1'
const HKDF_INFO = 'private-key'

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretDecryptionError'
  }
}

function deriveKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.AUTH_SECRET,
      Buffer.from(HKDF_SALT),
      Buffer.from(HKDF_INFO),
      AES_KEY_BYTES,
    ),
  )
}

/** Encrypt a UTF-8 secret; returns base64 of `nonce | ciphertext | tag`. */
export function encryptSecret(plaintext: string): string {
  const nonce = randomBytes(AES_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ciphertext, tag]).toString('base64')
}

/** Decrypt a value produced by {@link encryptSecret}. Throws on tampering or a changed AUTH_SECRET. */
export function decryptSecret(blob: string): string {
  try {
    const raw = Buffer.from(blob, 'base64')
    if (raw.length < AES_NONCE_BYTES + AES_TAG_BYTES + 1) {
      throw new Error('ciphertext too short')
    }
    const nonce = raw.subarray(0, AES_NONCE_BYTES)
    const tag = raw.subarray(raw.length - AES_TAG_BYTES)
    const ciphertext = raw.subarray(AES_NONCE_BYTES, raw.length - AES_TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new SecretDecryptionError(
      `decrypt secret failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
