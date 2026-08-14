import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../email/email.service';
import {
  ReminderChannel,
  ReminderChannelInput,
  ReminderChannelKind,
  ReminderChannelResult,
} from '../reminder-channel.interface';

@Injectable()
export class EmailReminderChannel implements ReminderChannel {
  readonly name = 'email';
  readonly kind: ReminderChannelKind = 'email';

  private readonly logger = new Logger(EmailReminderChannel.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // Every user has an email on file, so this channel is always attempted
  // by the dispatch orchestrator. The orchestrator sweeps every user
  // independently and treats a thrown error as a bug in the channel, not
  // a delivery failure, so any failure here resolves to { ok: false }
  // instead of propagating - a bad send for one user must not stop the
  // sweep from reaching the next one.
  async send(input: ReminderChannelInput): Promise<ReminderChannelResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        this.logger.warn(
          `Skipping reminder email, no user found for userId=${input.userId}`,
        );
        return { ok: false };
      }

      await this.emailService.sendReminderEmail({
        toEmail: user.email,
        title: input.title,
        body: input.body,
      });

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Reminder email failed for userId=${input.userId}: ${message}`,
      );
      return { ok: false };
    }
  }
}
