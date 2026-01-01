import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase body size limit for large images
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // Enable CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || ['http://localhost:3000', 'http://localhost:3001'],
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
    .setTitle('GoalSlot API')
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

  const port = process.env.PORT || 4000;
  await app.listen(port);
  
  console.log(`
  ⚡ GoalSlot API
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀 Server running on: http://localhost:${port}
  📚 API Docs: http://localhost:${port}/api/docs
  🔑 Environment: ${process.env.NODE_ENV || 'development'}
  `);
}

bootstrap();
