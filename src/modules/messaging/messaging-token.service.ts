import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { MessagingConfigService } from './messaging-config.service';

export interface MintedMessagingToken {
  token: string;
  /** Lifetime in seconds, so a client can schedule its own refresh. */
  expiresIn: number;
  expiresAt: string;
}

/**
 * Mints the short-lived bearer tokens that jiffy-messaging verifies.
 *
 * The service is configured with our shared HMAC secret and reads the
 * GoalSlot user id straight off the standard `sub` claim, so the contract
 * here is small: sign `sub` with the shared secret, set `iss`/`aud` to
 * whatever the service expects, keep it short-lived.
 */
@Injectable()
export class MessagingTokenService {
  /**
   * Its own signer rather than the JwtService AuthModule registers. These
   * tokens use a different secret and a far shorter life than a GoalSlot
   * session token, and neither should drift when the other's settings
   * change. An empty options object means every claim is passed per call.
   */
  private readonly jwt = new JwtService({});

  constructor(private readonly config: MessagingConfigService) {}

  async mint(userId: string): Promise<MintedMessagingToken> {
    const config = this.config.require();

    // Claims go through sign options rather than the payload: jsonwebtoken
    // throws when a registered claim is set in both places.
    const token = await this.jwt.signAsync(
      {},
      {
        secret: config.jwtSecret,
        algorithm: 'HS256',
        subject: userId,
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: config.tokenTtlSeconds,
      },
    );

    return {
      token,
      expiresIn: config.tokenTtlSeconds,
      expiresAt: new Date(
        Date.now() + config.tokenTtlSeconds * 1000,
      ).toISOString(),
    };
  }
}
