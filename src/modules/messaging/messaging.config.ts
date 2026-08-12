/**
 * Configuration for the jiffy-messaging integration.
 *
 * Every one of these variables is optional at boot. GoalSlot runs
 * perfectly well with messaging switched off, so an unset URL or secret
 * must never take the API down — it disables the /messaging endpoints and
 * touches nothing else. That is why this file is a pure function
 * returning `null` rather than a validator that throws.
 */
export interface MessagingConfig {
  /** Base URL of the jiffy-messaging service, no trailing slash. */
  baseUrl: string;
  /** HMAC secret. Must be byte-identical to the service's own JWT_SECRET. */
  jwtSecret: string;
  /** Signed as `iss`. Must match the service's JWT_ISSUER. */
  issuer: string;
  /** Signed as `aud`. Must match the service's JWT_AUDIENCE. */
  audience: string;
  tokenTtlSeconds: number;
  requestTimeoutMs: number;
}

export const MESSAGING_CONFIG_DEFAULTS = {
  issuer: 'goalslot-api',
  audience: 'jiffy-messaging',
  /** 15 minutes. Clients re-POST /messaging/token to refresh. */
  tokenTtlSeconds: 900,
  requestTimeoutMs: 5000,
} as const;

export type EnvReader = (key: string) => unknown;

/**
 * Tolerates a non-string: Joi coerces some values on the way into
 * ConfigService, and a `.trim()` on a number would be a crash at boot.
 */
function readTrimmed(read: EnvReader, key: string): string | undefined {
  const raw = read(key);
  if (raw === undefined || raw === null) return undefined;

  const value = String(raw).trim();
  return value ? value : undefined;
}

/**
 * Falls back rather than throwing on a malformed number: a typo in an
 * optional tuning knob is not a reason to refuse to serve messaging.
 */
function readPositiveInt(read: EnvReader, key: string, fallback: number): number {
  const raw = readTrimmed(read, key);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns `null` when the integration is not configured, which every
 * caller must treat as "messaging is off", not as an error.
 */
export function readMessagingConfig(read: EnvReader): MessagingConfig | null {
  const baseUrl = readTrimmed(read, 'JIFFY_MESSAGING_URL');
  const jwtSecret = readTrimmed(read, 'JIFFY_MESSAGING_JWT_SECRET');

  if (!baseUrl || !jwtSecret) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    jwtSecret,
    issuer:
      readTrimmed(read, 'JIFFY_MESSAGING_JWT_ISSUER') ??
      MESSAGING_CONFIG_DEFAULTS.issuer,
    audience:
      readTrimmed(read, 'JIFFY_MESSAGING_JWT_AUDIENCE') ??
      MESSAGING_CONFIG_DEFAULTS.audience,
    tokenTtlSeconds: readPositiveInt(
      read,
      'JIFFY_MESSAGING_TOKEN_TTL',
      MESSAGING_CONFIG_DEFAULTS.tokenTtlSeconds,
    ),
    requestTimeoutMs: readPositiveInt(
      read,
      'JIFFY_MESSAGING_TIMEOUT_MS',
      MESSAGING_CONFIG_DEFAULTS.requestTimeoutMs,
    ),
  };
}
