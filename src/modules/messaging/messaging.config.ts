import { createHash, timingSafeEqual } from 'crypto';

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
function readPositiveInt(
  read: EnvReader,
  key: string,
  fallback: number,
): number {
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

/**
 * The credential jiffy-messaging's ConversationGate callback presents on
 * POST /internal/messaging/can-create-conversation. Independent of
 * everything above: this API can receive that callback whether or not it
 * is itself configured to call out to jiffy-messaging, and the outbound
 * JIFFY_MESSAGING_* variables are not required for it to be set. Returns
 * null (rather than throwing) for the same boot-safety reason the rest of
 * this file does — an internal endpoint with no secret configured simply
 * stays unreachable instead of taking the process down.
 */
export function readConversationGateSecret(read: EnvReader): string | null {
  return readTrimmed(read, 'CONVERSATION_GATE_SECRET') ?? null;
}

/**
 * The credential jiffy-messaging's MessageNotifier callback presents on
 * POST /internal/messaging/on-message-sent. Deliberately a separate
 * variable from CONVERSATION_GATE_SECRET — this endpoint and the gate
 * endpoint are different capabilities, and a caller with one should not
 * automatically have the other. Same null-not-throw reasoning as
 * readConversationGateSecret: an unset value just leaves this endpoint
 * unreachable.
 */
export function readMessageNotifySecret(read: EnvReader): string | null {
  return readTrimmed(read, 'MESSAGE_NOTIFY_SECRET') ?? null;
}

/**
 * Constant-time comparison that never throws on a length mismatch.
 * `timingSafeEqual` requires equal-length buffers, so both sides are
 * hashed to a fixed 32-byte digest first — that also means the secret's
 * own length leaks nothing through timing, not just its content.
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
