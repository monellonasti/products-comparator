// Symmetric encryption for supplier feed secrets (URL with tokens, passwords, API tokens).
// AES-256-GCM with a 32-byte key from SECRETS_KEY (base64). The AAD binds a ciphertext to its row
// (supplier id + secret name): a value copied onto another supplier does not decrypt.
// Losing SECRETS_KEY means re-entering feed credentials; rotating it requires re-saving them.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class SecretsUnavailableError extends Error {}

export function parseKey(base64: string | undefined): Buffer {
  if (!base64) throw new SecretsUnavailableError('SECRETS_KEY non configurata: impossibile salvare o usare credenziali dei feed');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new SecretsUnavailableError('SECRETS_KEY deve essere di 32 byte in base64 (es. openssl rand -base64 32)');
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(key: Buffer, encoded: string, aad: string): string {
  const [version, iv, tag, ct] = encoded.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Formato del segreto non riconosciuto');
  // A truncated tag would weaken the integrity check: only the full 16 bytes written by encryptSecret pass.
  const tagBytes = Buffer.from(tag, 'base64url');
  if (tagBytes.length !== 16) throw new Error('Formato del segreto non riconosciuto');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
