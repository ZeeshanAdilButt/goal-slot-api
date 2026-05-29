import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachProfileController } from './coach-profile.controller';
import { CoachProfileService } from './coach-profile.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachProfileController],
  providers: [CoachProfileService],
  exports: [CoachProfileService],
})
export class CoachProfileModule {}
