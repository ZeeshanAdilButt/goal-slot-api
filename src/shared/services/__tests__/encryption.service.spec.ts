import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { EncryptionService } from '../encryption.service';

function buildService(): EncryptionService {
  // Generate a fresh 32-byte master key for tests, base64-encoded as the env var would be.
  const base64Key = crypto.randomBytes(32).toString('base64');
  const config = {
    getOrThrow: (k: string) => {
      if (k === 'BYOK_ENCRYPTION_KEY') return base64Key;
      throw new Error(`Unexpected key: ${k}`);
    },
  } as unknown as ConfigService;
  return new EncryptionService(config);
}

describe('EncryptionService', () => {
  it('round-trips ASCII plaintext', () => {
    const svc = buildService();
    const plaintext = 'sk-test-1234567890ABCDEFghij';
    const enc = svc.encrypt(plaintext);
    const dec = svc.decrypt(enc);
    expect(dec).toBe(plaintext);
  });

  it('round-trips Unicode plaintext', () => {
    const svc = buildService();
    const plaintext = 'sk-ant-🎯-emoji-test-Ω';
    const enc = svc.encrypt(plaintext);
    const dec = svc.decrypt(enc);
    expect(dec).toBe(plaintext);
  });

  it('rejects tampered ciphertext or authTag (GCM authentication)', () => {
    const svc = buildService();
    const plaintext = 'super-secret-api-key';
    const enc = svc.encrypt(plaintext);

    // Tamper with ciphertext
    const tamperedCiphertext = Buffer.from(enc.ciphertext);
    tamperedCiphertext[0] = tamperedCiphertext[0] ^ 0x01;
    expect(() =>
      svc.decrypt({ ...enc, ciphertext: tamperedCiphertext }),
    ).toThrow();

    // Tamper with authTag
    const tamperedTag = Buffer.from(enc.authTag);
    tamperedTag[0] = tamperedTag[0] ^ 0x01;
    expect(() => svc.decrypt({ ...enc, authTag: tamperedTag })).toThrow();
  });

  it('generates a unique IV for every encrypt call (1000 iterations)', () => {
    const svc = buildService();
    const plaintext = 'same-input-many-times';
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { iv } = svc.encrypt(plaintext);
      seen.add(iv.toString('hex'));
    }
    expect(seen.size).toBe(1000);
  });
});
