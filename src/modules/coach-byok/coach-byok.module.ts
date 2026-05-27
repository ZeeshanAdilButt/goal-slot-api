import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachByokController } from './coach-byok.controller';
import { CoachByokService } from './coach-byok.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachByokController],
  providers: [CoachByokService],
  exports: [CoachByokService],
})
export class CoachByokModule {}
