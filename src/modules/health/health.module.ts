import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessController } from './readiness.controller';
import { HealthService } from './health.service';

@Module({
  providers: [HealthService],
  controllers: [HealthController, ReadinessController],
})
export class HealthModule {}
