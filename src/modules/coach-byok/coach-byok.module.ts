import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../../shared/modules/llm.module';
import { CoachByokController } from './coach-byok.controller';
import { CoachByokService } from './coach-byok.service';

@Module({
  imports: [AuthModule, LlmModule],
  controllers: [CoachByokController],
  providers: [CoachByokService],
  exports: [CoachByokService],
})
export class CoachByokModule {}
