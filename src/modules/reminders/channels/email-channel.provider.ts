import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../../prisma/prisma.service";
import { EmailService } from "../../email/email.service";

// Local structural copy of the shared reminder-channel contract. The real
// `reminder-channel.interface.ts` is owned by another agent and may not
// exist yet in this worktree; this shape must stay byte-for-byte
// compatible with it so the later integration pass can swap this for a
// real import without touching the implementation below.
export interface ReminderChannel {
  readonly name: string;
  send(input: ReminderChannelInput): Promise<ReminderChannelResult>;
}

export interface ReminderChannelInput {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ReminderChannelResult {
  ok: boolean;
  subscriptionGone?: boolean;
}

@Injectable()
export class EmailReminderChannel implements ReminderChannel {
  readonly name = "email";

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
