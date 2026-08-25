import { ConfigService } from '@nestjs/config';

/**
 * Every CLI knob is optional and carries a working default.
 *
 * This is deliberate and non-negotiable in this repo: a required env var read
 * from a constructor has taken the whole API down twice (see the long comment
 * on googleStrategyProvider in auth.module.ts). Nothing here throws, nothing
 * here is validated in env.validation.ts as required, and an environment that
 * sets none of these still gets a fully working CLI login.
 */
export const CLI_DEFAULTS = {
  accessTokenTtl: '1h',
  refreshTokenDays: 90,
  refreshTokenAbsoluteDays: 365,
  sessionTtlSeconds: 600,
} as const;

export interface CliAuthConfig {
  /** JWT `expiresIn` string for the CLI access token. */
  accessTokenTtl: string;
  /** Sliding lifetime of the opaque refresh token, extended on every rotation. */
  refreshTokenDays: number;
  /** Hard ceiling the sliding lifetime is never allowed to pass. */
  refreshTokenAbsoluteDays: number;
  /** How long a pending approval stays open. */
  sessionTtlSeconds: number;
}

/**
 * Reads a positive integer, falling back to `fallback` for anything missing,
 * blank, non-numeric, zero or negative. A typo in the deploy environment
 * degrades to the default rather than producing a zero-second session TTL that
 * would silently break every login.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getCliAuthConfig(configService: ConfigService): CliAuthConfig {
  const ttl = configService.get<string>('CLI_ACCESS_TOKEN_TTL');

  const refreshTokenDays = positiveInt(
    configService.get<string>('CLI_REFRESH_TOKEN_DAYS'),
    CLI_DEFAULTS.refreshTokenDays,
  );
  const refreshTokenAbsoluteDays = positiveInt(
    configService.get<string>('CLI_REFRESH_TOKEN_ABSOLUTE_DAYS'),
    CLI_DEFAULTS.refreshTokenAbsoluteDays,
  );

  return {
    accessTokenTtl:
      typeof ttl === 'string' && ttl.trim() !== ''
        ? ttl.trim()
        : CLI_DEFAULTS.accessTokenTtl,
    refreshTokenDays,
    // A sliding window longer than the absolute ceiling is a misconfiguration
    // that would make the ceiling meaningless; clamp instead of trusting it.
    refreshTokenAbsoluteDays: Math.max(
      refreshTokenAbsoluteDays,
      refreshTokenDays,
    ),
    sessionTtlSeconds: positiveInt(
      configService.get<string>('CLI_SESSION_TTL_SECONDS'),
      CLI_DEFAULTS.sessionTtlSeconds,
    ),
  };
}
