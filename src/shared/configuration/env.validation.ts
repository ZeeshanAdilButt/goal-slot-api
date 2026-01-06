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

  // CORS
  CORS_ORIGIN: Joi.alternatives()
  .try(
    Joi.string().uri(),
    Joi.array().items(Joi.string().uri())
  )
  .optional(),
});