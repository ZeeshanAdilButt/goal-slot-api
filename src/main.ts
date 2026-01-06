import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Increase body size limit for large images
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  const corsOrigin = configService.get<string | string[]>('CORS_ORIGIN') ||
    ['http://localhost:3000', 'http://localhost:3001'];
  const corsOrigins = Array.isArray(corsOrigin)
    ? corsOrigin
    : [corsOrigin];

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
      forbidNonWhitelisted: true,
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
