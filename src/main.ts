import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { PostHogExceptionFilter } from './shared/filters/posthog-exception.filter';
import { PostHogService } from './shared/services/posthog.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Get PostHog service instance
  const posthogService = app.get(PostHogService);

  // Register global exception filter
  app.useGlobalFilters(new PostHogExceptionFilter(posthogService));

  // Increase body size limit for large images
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // getOrThrow is safe here because CORS_ORIGIN is required in
  // env.validation.ts, so a missing value is caught during validation with a
  // message naming the variable, rather than here after Nest has started.
  // Keep the two in step: making the schema optional again puts the failure
  // back where it cannot be read.
  const corsOrigin = configService.getOrThrow<string>('CORS_ORIGIN');
  const corsOrigins = corsOrigin.split(',').map((url) => url.trim());

  // Enable CORS
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // API prefix
  app.setGlobalPrefix('api');

  // Swagger documentation. Not mounted in production: it published a full,
  // browsable map of every route and body shape to anonymous callers.
  const nodeEnv = configService.get<string>('NODE_ENV') || 'development';
  const swaggerEnabled = nodeEnv !== 'production';

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Time Master API')
      .setDescription('API for productivity tracking and goal management')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('health', 'Health check endpoints')
      .addTag('auth', 'Authentication endpoints')
      .addTag('users', 'User management')
      .addTag('goals', 'Goals management')
      .addTag('time-entries', 'Time tracking')
      .addTag('active-timer', 'Cross-device active timer session')
      .addTag('schedule', 'Schedule planning')
      .addTag('reports', 'Analytics and reports')
      .addTag('sharing', 'Access sharing')
      .addTag('stripe', 'Subscription management')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get<number>('PORT') || 4000;
  await app.listen(port);
  console.log(`
  ⚡ Time Master API
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀 Server running on: http://localhost:${port}
  📚 API Docs: ${swaggerEnabled ? `http://localhost:${port}/api/docs` : 'disabled in production'}
  🔑 Environment: ${nodeEnv}
  `);
}

// Without this, anything bootstrap throws surfaces as an unhandled rejection
// with no context, which is how a configuration problem ends up looking like
// a runtime crash in the service logs.
bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start the API: ${message}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
