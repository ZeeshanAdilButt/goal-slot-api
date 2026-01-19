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

  // Supabase
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

  // Email (Resend)
  RESEND_API_KEY: Joi.string().required(),
  APP_URL: Joi.string().uri().required(),

  // Stripe
  STRIPE_SECRET_KEY: Joi.string().required(),
  STRIPE_PRICE_ID: Joi.string().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().required(),

  // CORS - accepts comma-separated list of URIs
  CORS_ORIGIN: Joi.string()
    .custom((value, helpers) => {
      // Split by comma and validate each URL
      const urls = value.split(',').map((url: string) => url.trim());
      const uriSchema = Joi.string().uri();
      
      for (const url of urls) {
        const { error } = uriSchema.validate(url);
        if (error) {
          return helpers.error('any.invalid', { message: `Invalid URI in CORS_ORIGIN: ${url}` });
        }
      }
      return value; // Return the original string, we'll parse it in main.ts
    }, 'CORS origin validation')
    .optional(),

  // PostHog
  POSTHOG_API_KEY: Joi.string().optional(),
  POSTHOG_HOST: Joi.string().uri().optional(),
});