import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReminderDispatchService } from './reminder-dispatch.service';

@Injectable()
export class ReminderCronService {
  private readonly logger = new Logger(ReminderCronService.name);

  constructor(private readonly reminderDispatchService: ReminderDispatchService) {}

  // First scheduled job in this API - see the design spec's "Cron" section
  // for why there is no prior pattern to follow. A thrown error here would
  // otherwise be an unhandled rejection inside the schedule module's timer,
  // so it is caught and logged rather than left to crash the process.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async handleDailySweep(): Promise<void> {
    try {
      await this.reminderDispatchService.runDailySweep();
    } catch (error) {
      this.logger.error(`Daily reminder sweep failed: ${(error as Error).message}`);
    }
  }
}
