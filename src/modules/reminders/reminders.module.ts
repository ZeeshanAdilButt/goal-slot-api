import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ReminderDispatchService } from './reminder-dispatch.service';
import { ReminderCronService } from './reminder-cron.service';
import { REMINDER_CHANNELS } from './reminder-channel.interface';

@Module({
  imports: [PrismaModule],
  providers: [
    ReminderDispatchService,
    ReminderCronService,
    // Real channel implementations (email, web-push, expo-push) are owned by
    // their own modules and get wired in here under REMINDER_CHANNELS in a
    // later integration pass. Defaulting to an empty array keeps this module
    // buildable and testable on its own until then.
    { provide: REMINDER_CHANNELS, useValue: [] },
  ],
  exports: [ReminderDispatchService],
})
export class RemindersModule {}
