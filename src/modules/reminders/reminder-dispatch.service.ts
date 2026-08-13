import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REMINDER_CHANNELS, ReminderChannel } from './reminder-channel.interface';
import { isInstructionReminderDue, isReportViewReminderDue } from './reminder-staleness';

export interface ReminderDispatchContent {
  title: string;
  body: string;
  data: Record<string, unknown>;
  notificationType: NotificationType;
}

@Injectable()
export class ReminderDispatchService {
  private readonly logger = new Logger(ReminderDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REMINDER_CHANNELS) private readonly channels: ReminderChannel[],
  ) {}

  /**
   * Entry point for the daily cron. The two trigger sources are independent
   * of each other - the pending-instructions pass still runs even if the
   * report-staleness pass throws outright, since they touch different
   * tables and share nothing but the dispatch path.
   */
  async runDailySweep(): Promise<void> {
    const now = new Date();

    try {
      await this.sweepStaleReports(now);
    } catch (error) {
      this.logger.error(`Report-staleness sweep failed: ${(error as Error).message}`);
    }

    try {
      await this.sweepPendingInstructions(now);
    } catch (error) {
      this.logger.error(`Pending-instructions sweep failed: ${(error as Error).message}`);
    }
  }

  private async sweepStaleReports(now: Date): Promise<void> {
    // Fetch every accepted share and decide staleness in code rather than in
    // the query - lastViewedAt and lastViewReminderAt each need their own
    // null-or-older-than-threshold check, and keeping that logic in
    // isReminderDue keeps it testable without a database.
    const shares = await this.prisma.sharedAccess.findMany({
      where: { isAccepted: true, sharedWithId: { not: null } },
      include: { owner: { select: { name: true } } },
    });

    const dueShares = shares.filter((share) =>
      isReportViewReminderDue(now, share.lastViewedAt, share.lastViewReminderAt),
    );

    for (const share of dueShares) {
      try {
        const menteeName = share.owner?.name ?? 'a mentee';
        const succeeded = await this.dispatchToUser(share.sharedWithId as string, {
          title: `${menteeName}'s report needs a look`,
          body: `You haven't checked ${menteeName}'s report in over a week.`,
          data: { type: 'schedule', sharedAccessId: share.id },
          notificationType: NotificationType.SHARED_REPORT_UNVIEWED,
        });

        if (succeeded) {
          await this.prisma.sharedAccess.update({
            where: { id: share.id },
            data: { lastViewReminderAt: now },
          });
        }
      } catch (error) {
        // One share's failure must not stop the sweep from reaching the
        // next one - it is left for tomorrow's sweep to retry.
        this.logger.error(
          `Failed to dispatch report-staleness reminder for sharedAccess ${share.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async sweepPendingInstructions(now: Date): Promise<void> {
    const instructions = await this.prisma.instruction.findMany({
      where: { status: 'PENDING' },
    });

    const dueInstructions = instructions.filter((instruction) =>
      isInstructionReminderDue(now, instruction.lastReminderAt),
    );

    for (const instruction of dueInstructions) {
      await this.sendInstructionReminder(instruction, now);
    }
  }

  /**
   * Sends a single pending-instruction reminder to its assignee across every
   * channel and, on success, advances lastReminderAt so the daily sweep
   * doesn't immediately re-notify about the same instruction. Shared by the
   * daily sweep (one call per due instruction) and InstructionsService.assign
   * (one immediate call right after creation), so the copy and channel
   * fan-out can never drift between the two call sites.
   *
   * Never throws - a failed send (no channels configured, every provider
   * down, an unexpected error) is logged and resolves to false rather than
   * propagating, since neither the sweep loop nor instruction creation
   * should be interrupted by a notification hiccup.
   */
  async sendInstructionReminder(
    instruction: { id: string; assigneeId: string; title: string },
    now: Date,
  ): Promise<boolean> {
    try {
      const succeeded = await this.dispatchToUser(instruction.assigneeId, this.buildInstructionContent(instruction));

      if (succeeded) {
        await this.prisma.instruction.update({
          where: { id: instruction.id },
          data: { lastReminderAt: now },
        });
      }

      return succeeded;
    } catch (error) {
      this.logger.error(
        `Failed to dispatch instruction reminder for instruction ${instruction.id}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private buildInstructionContent(instruction: { id: string; title: string }): ReminderDispatchContent {
    return {
      title: `Reminder: ${instruction.title}`,
      body: `Your mentor is waiting on: ${instruction.title}`,
      data: { type: 'instruction', instructionId: instruction.id },
      notificationType: NotificationType.INSTRUCTION_ASSIGNED,
    };
  }

  /**
   * Fans a single reminder out to every injected channel in parallel and
   * always creates the matching in-app Notification row alongside it. Uses
   * allSettled rather than all because one channel rejecting must not stop
   * the others from being attempted or awaited. The in-app notification is
   * not one of the injected channels - it is unconditional and does not
   * affect the return value.
   */
  async dispatchToUser(userId: string, content: ReminderDispatchContent): Promise<boolean> {
    await this.createInAppNotification(userId, content);

    const results = await Promise.allSettled(
      this.channels.map((channel) =>
        channel.send({
          userId,
          title: content.title,
          body: content.body,
          data: content.data,
        }),
      ),
    );

    let anySucceeded = false;
    results.forEach((result, index) => {
      const channel = this.channels[index];

      if (result.status === 'rejected') {
        this.logger.error(`Reminder channel "${channel.name}" threw for user ${userId}: ${result.reason}`);
        return;
      }

      if (result.value.subscriptionGone) {
        // Deleting the dead subscription row belongs to the push-subscriptions
        // module in a later phase - this dispatcher only surfaces it.
        this.logger.warn(`Reminder channel "${channel.name}" reports a gone subscription for user ${userId}`);
      }

      if (result.value.ok) {
        anySucceeded = true;
      } else {
        this.logger.warn(`Reminder channel "${channel.name}" failed for user ${userId}`);
      }
    });

    return anySucceeded;
  }

  private async createInAppNotification(userId: string, content: ReminderDispatchContent): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          type: content.notificationType,
          title: content.title,
          body: content.body,
          data: content.data as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // The in-app row is a nice-to-have alongside the real channels, not a
      // gate on them - a failure here should not block email/push delivery.
      this.logger.error(`Failed to create in-app notification for user ${userId}: ${(error as Error).message}`);
    }
  }
}
