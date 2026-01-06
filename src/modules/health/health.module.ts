import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [HealthController],
})
export class HealthModule {}

