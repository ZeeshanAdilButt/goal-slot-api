import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion?: number;
}

/**
 * AES-256-GCM symmetric encryption used for BYOK API keys at rest.
 *
 * The master key is derived from the base64-encoded `BYOK_ENCRYPTION_KEY`
 * environment variable (must decode to exactly 32 bytes — validated at boot).
 *
 * SECURITY: never log plaintext or ciphertext from this service.
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12;

  constructor(config: ConfigService) {
    this.key = Buffer.from(
      config.getOrThrow<string>('BYOK_ENCRYPTION_KEY'),
      'base64',
    );
  }

  encrypt(plaintext: string): {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
  } {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 1 };
  }

  decrypt(p: EncryptedPayload): string {
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, p.iv);
    decipher.setAuthTag(p.authTag);
    return Buffer.concat([
      decipher.update(p.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
