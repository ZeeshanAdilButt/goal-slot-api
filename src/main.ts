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

  const corsOrigin = configService.getOrThrow<string>('CORS_ORIGIN')
  const corsOrigins = corsOrigin.split(',').map(url => url.trim());

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

  // Swagger documentation
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
    .addTag('schedule', 'Schedule planning')
    .addTag('reports', 'Analytics and reports')
    .addTag('sharing', 'Access sharing')
    .addTag('stripe', 'Subscription management')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('PORT') || 4000;
  await app.listen(port);
  console.log(`
  ⚡ Time Master API
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀 Server running on: http://localhost:${port}
  📚 API Docs: http://localhost:${port}/api/docs
  🔑 Environment: ${configService.get<string>('NODE_ENV') || 'development'}
  `);
}

bootstrap();
