import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Server
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(4000),

  // Database
  DATABASE_URL: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().default('7d'),

  // Supabase — still backs SSO login (SupabaseService.verifySSOToken /
  // AuthService.ssoLogin), so this stays required rather than optional:
  // booting without it would silently take SSO down with no signal.
  // Production doesn't have a real Supabase project wired up yet and runs
  // on a localhost placeholder here (see .env.example); GET /api/health/detailed
  // detects that placeholder and skips the live connectivity check instead
  // of reporting the whole service down.
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

  // Google sign-in (optional). All three are allowed to be absent: AuthModule
  // only builds the Google strategy when the id and secret are both present,
  // and the /auth/google routes 404 until then. Making these required would
  // reintroduce exactly the boot failure that got the first attempt reverted,
  // just one layer earlier.
  GOOGLE_CLIENT_ID: Joi.string().optional().allow(''),
  GOOGLE_CLIENT_SECRET: Joi.string().optional().allow(''),
  GOOGLE_CALLBACK_URL: Joi.string().uri().optional().allow(''),

  // Google Calendar import (optional), which reuses GOOGLE_CLIENT_ID and
  // GOOGLE_CLIENT_SECRET above and only needs its own redirect URI — the
  // calendar callback is a different path from the sign-in one, so Google has
  // to have it registered separately.
  //
  // This variable doubles as the feature switch: while it is blank the
  // /api/integrations/google-calendar/* routes 404 and nothing else changes.
  // `.allow('')` is not decoration — a deployment copying .env.example ships a
  // blank value, and a schema that rejected it would refuse to boot the API
  // over a feature that is meant to be off by default.
  GOOGLE_CALENDAR_REDIRECT_URI: Joi.string().uri().optional().allow(''),

  // Where the OAuth callback sends the browser once tokens are minted.
  // Falls back to APP_URL when unset (see resolveFrontendUrl).
  FRONTEND_URL: Joi.string().uri().optional().allow(''),

  // Email (Resend)
  RESEND_API_KEY: Joi.string().required(),
  APP_URL: Joi.string().uri().required(),
  ONBOARDING_EMAIL: Joi.string().required(),
  NOTIFICATION_EMAIL: Joi.string().required(),

  // Stripe
  STRIPE_SECRET_KEY: Joi.string().required(),
  STRIPE_PRICE_ID: Joi.string().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().required(),

  // Per-tier Stripe prices. Required rather than optional on purpose: when
  // they were missing, StripeService fell back to the single STRIPE_PRICE_ID
  // and every tier quietly billed at the same amount. A boot failure is far
  // easier to notice than a month of wrong invoices.
  STRIPE_PRICE_ID_BASIC: Joi.string().required(),
  STRIPE_PRICE_ID_PRO: Joi.string().required(),

  // CORS - accepts comma-separated list of URIs.
  //
  // Required, because main.ts reads it with getOrThrow. Leaving it optional
  // here meant validation passed and bootstrap then threw an unhandled
  // rejection after Nest had already started, which reads like a runtime
  // crash rather than the configuration error it is.
  CORS_ORIGIN: Joi.string()
    .custom((value, helpers) => {
      // Split by comma and validate each URL
      const urls = value.split(',').map((url: string) => url.trim());
      const uriSchema = Joi.string().uri();

      for (const url of urls) {
        const { error } = uriSchema.validate(url);
        if (error) {
          return helpers.error('any.invalid', {
            message: `Invalid URI in CORS_ORIGIN: ${url}`,
          });
        }
      }
      return value; // Return the original string, we'll parse it in main.ts
    }, 'CORS origin validation')
    .required(),

  // PostHog. An empty POSTHOG_API_KEY is allowed and means "analytics off",
  // which is what a fresh clone wants; PostHogService already treats a blank
  // key that way.
  POSTHOG_API_KEY: Joi.string().optional().allow(''),
  POSTHOG_HOST: Joi.string().uri().optional(),

  // Coach feature — AES-256-GCM master key for encrypting user BYOK keys at rest
  BYOK_ENCRYPTION_KEY: Joi.string()
    .required()
    .custom((value, helpers) => {
      try {
        const buf = Buffer.from(value, 'base64');
        if (buf.length !== 32) {
          return helpers.error('any.invalid', {
            message: 'BYOK_ENCRYPTION_KEY must decode to 32 bytes',
          });
        }
        return value;
      } catch {
        return helpers.error('any.invalid', {
          message: 'BYOK_ENCRYPTION_KEY must be base64',
        });
      }
    }, 'BYOK key validation'),

  // Optional shared Gemini Flash fallback so users without their own
  // BYOK key can still try the Coach. Disabled when not set; daily
  // per-user cap defaults to 20.
  GOOGLE_AI_SHARED_API_KEY: Joi.string().optional().allow(''),
  SHARED_COACH_DAILY_LIMIT: Joi.number().integer().min(1).max(1000).default(20),

  // jiffy-messaging integration (optional).
  //
  // Listed here for discoverability, but deliberately validated as loose
  // optional strings rather than .uri()/.number(): a Joi failure in this
  // schema aborts ConfigModule and the whole API never boots. A messaging
  // variable is never worth that. Shape and defaults are handled in
  // src/modules/messaging/messaging.config.ts, which falls back instead of
  // throwing, and the endpoints answer 503 while URL or secret are unset.
  JIFFY_MESSAGING_URL: Joi.string().optional().allow(''),
  JIFFY_MESSAGING_JWT_SECRET: Joi.string().optional().allow(''),
  JIFFY_MESSAGING_JWT_ISSUER: Joi.string().optional().allow(''),
  JIFFY_MESSAGING_JWT_AUDIENCE: Joi.string().optional().allow(''),
  JIFFY_MESSAGING_TOKEN_TTL: Joi.string().optional().allow(''),
  JIFFY_MESSAGING_TIMEOUT_MS: Joi.string().optional().allow(''),

  // Credential jiffy-messaging's ConversationGate callback presents to
  // POST /internal/messaging/can-create-conversation (see
  // MessagingConfigService.verifyGateSecret). Independent of the
  // JIFFY_MESSAGING_* block above — loose and optional for the same
  // boot-safety reason: unset means that endpoint rejects every request,
  // never that ConfigModule refuses to start.
  CONVERSATION_GATE_SECRET: Joi.string().optional().allow(''),

  // Credential jiffy-messaging's MessageNotifier callback presents to
  // POST /internal/messaging/on-message-sent (see
  // MessagingConfigService.verifyNotifySecret). Independent of the
  // JIFFY_MESSAGING_* block the same way CONVERSATION_GATE_SECRET is —
  // still optional when messaging itself is off, for the same boot-safety
  // reason. But unlike the gate secret, this one is conditioned on
  // JIFFY_MESSAGING_URL: once that is set, the deploy clearly intends
  // messaging to be live, and leaving this unset silently turns every
  // message sent into a no-op notification (a boot warning, nothing more)
  // rather than something a deploy would ever choose on purpose. Required
  // only in that case, so a drifted/typo'd value fails loudly at boot
  // instead of failing closed at request time with no signal.
  MESSAGE_NOTIFY_SECRET: Joi.string()
    .optional()
    .allow('')
    .when('JIFFY_MESSAGING_URL', {
      // `.required()` here matters: without it, an *unset* JIFFY_MESSAGING_URL
      // would still satisfy `Joi.string().min(1)` (an optional peer schema
      // treats a missing value as trivially valid), so the "then" branch
      // would fire even when messaging is off entirely.
      is: Joi.string().min(1).required(),
      then: Joi.string().required(),
    }),

  // Web push (VAPID) keys. Read directly via process.env in
  // WebPushReminderChannel, not through ConfigService (see
  // src/modules/push-subscriptions/channels/web-push-channel.provider.ts) —
  // validated here anyway purely for discoverability and typo-catching,
  // not because the channel needs it. An entirely-unset trio is a normal,
  // expected state (the channel degrades to a no-op sender), so all three
  // stay optional. But the three travel together: once one is set the
  // deploy clearly intends web push on, so the other two become required —
  // otherwise the channel silently stays disabled with only a runtime
  // warning to say so, the same class of drift item 3 exists to catch.
  VAPID_PUBLIC_KEY: Joi.string().optional().allow(''),
  VAPID_PRIVATE_KEY: Joi.string()
    .optional()
    .allow('')
    .when('VAPID_PUBLIC_KEY', {
      // See the matching comment on MESSAGE_NOTIFY_SECRET above for why
      // `.required()` has to be part of the "is" schema, not just "then".
      is: Joi.string().min(1).required(),
      then: Joi.string().required(),
    }),
  VAPID_SUBJECT: Joi.string()
    .optional()
    .allow('')
    .when('VAPID_PUBLIC_KEY', {
      is: Joi.string().min(1).required(),
      then: Joi.string().required(),
    }),
  // Notion Integration
  NOTION_CLIENT_ID: Joi.string().optional().allow(''),
  NOTION_CLIENT_SECRET: Joi.string().optional().allow(''),
  NOTION_REDIRECT_URI: Joi.alternatives()
    .try(
      Joi.string().uri({ scheme: ['https'] }),
      Joi.string().pattern(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/),
    )
    .optional()
    .allow(''),
  // Dedicated HMAC signing key for OAuth state tokens (all integrations share this).
  // Optional: falls back to JWT_SECRET if not set so existing dev envs keep working.
  // .allow('') because .env.example ships it blank -- without it, copying the
  // example verbatim fails validation and the whole API refuses to boot, which
  // is exactly what the "accepts .env.example as shipped" guard test caught.
  INTEGRATION_STATE_SECRET: Joi.string().optional().allow(''),
});
