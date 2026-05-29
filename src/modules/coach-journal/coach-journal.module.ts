import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoachJournalController } from './coach-journal.controller';
import { CoachJournalService } from './coach-journal.service';

@Module({
  imports: [AuthModule],
  controllers: [CoachJournalController],
  providers: [CoachJournalService],
  exports: [CoachJournalService],
})
export class CoachJournalModule {}
