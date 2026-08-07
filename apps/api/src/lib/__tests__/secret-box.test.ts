import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above const declarations, so the secret has to be hoisted too.
const { AUTH_SECRET } = vi.hoisted(() => ({ AUTH_SECRET: 'test-auth-secret-0123456789abcdef' }))
vi.mock('../../env.js', () => ({ env: { AUTH_SECRET } }))

import { SecretDecryptionError, decryptSecret, encryptSecret } from '../secret-box.js'

describe('secret-box', () => {
  it('round-trips a secret', async () => {
    expect(decryptSecret(encryptSecret('s3cret'))).toBe('s3cret')
  })

  it('produces a fresh nonce per call (same plaintext ⇒ different ciphertext)', async () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  /**
   * These bytes are the on-disk format. This module was extracted out of the
   * (now deleted) gateway JWT signer, which owned the HKDF salt/info; keeping
   * them verbatim is what lets an `sso.oidcClientSecretEnc` written by an older
   * build still be read back. A "cleanup" of those constants would derive a
   * different key and silently brick every stored secret — the failure surfaces
   * only when someone next logs in via OIDC against a confidential client, long
   * after the change lands. Hence this test reproduces the legacy derivation
   * independently rather than calling encryptSecret().
   */
  it('decrypts ciphertext produced by the pre-extraction key derivation', async () => {
    const legacyKey = Buffer.from(
      hkdfSync(
        'sha256',
        AUTH_SECRET,
        Buffer.from('a2wave-jwt-signer-v1'),
        Buffer.from('private-key'),
        32,
      ),
    )
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', legacyKey, nonce)
    const body = Buffer.concat([cipher.update('legacy-client-secret', 'utf8'), cipher.final()])
    const blob = Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')

    expect(decryptSecret(blob)).toBe('legacy-client-secret')
  })

  it('rejects a tampered ciphertext rather than returning garbage', async () => {
    const blob = Buffer.from(encryptSecret('s3cret'), 'base64')
    blob[blob.length - 1] ^= 0xff // corrupt the GCM tag
    expect(() => decryptSecret(blob.toString('base64'))).toThrow(SecretDecryptionError)
  })

  it('rejects a blob too short to hold a nonce and tag', async () => {
    expect(() => decryptSecret(Buffer.alloc(8).toString('base64'))).toThrow(SecretDecryptionError)
  })
})
