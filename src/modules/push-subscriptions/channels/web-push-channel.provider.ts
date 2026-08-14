import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../../../prisma/prisma.service';
import { PushSubscriptionsService } from '../push-subscriptions.service';
import {
  ReminderChannel,
  ReminderChannelInput,
  ReminderChannelKind,
  ReminderChannelResult,
} from '../../reminders/reminder-channel.interface';

@Injectable()
export class WebPushReminderChannel implements ReminderChannel {
  readonly name = 'web-push';
  readonly kind: ReminderChannelKind = 'push';

  private readonly logger = new Logger(WebPushReminderChannel.name);
  private readonly configured: boolean;

  constructor(
    private prisma: PrismaService,
    private pushSubscriptionsService: PushSubscriptionsService,
  ) {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim();

    // No VAPID keys configured (e.g. local dev) is a normal, expected state,
    // not an error — degrade to a no-op sender rather than throwing at
    // bootstrap, mirroring how PostHogService treats a missing API key.
    if (!publicKey || !privateKey || !subject) {
      this.logger.warn(
        'VAPID keys are not set. Web push reminders are disabled.',
      );
      this.configured = false;
      return;
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.configured = true;
  }

  async send(input: ReminderChannelInput): Promise<ReminderChannelResult> {
    if (!this.configured) {
      return { ok: false };
    }

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: input.userId, kind: 'WEB' },
    });

    if (subscriptions.length === 0) {
      return { ok: false };
    }

    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      data: input.data,
    });

    let anySucceeded = false;
    let goneCount = 0;

    for (const subscription of subscriptions) {
      if (
        !subscription.endpoint ||
        !subscription.p256dh ||
        !subscription.auth
      ) {
        continue;
      }

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        );
        anySucceeded = true;
      } catch (error) {
        const statusCode = error?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          goneCount += 1;
          // Clean up immediately rather than waiting for the caller —
          // a dead endpoint retried daily by the sweep is pure waste.
          await this.pushSubscriptionsService.deleteByEndpoint(
            input.userId,
            subscription.endpoint,
          );
        } else {
          this.logger.warn(
            `web push send failed for user ${input.userId}: ${error?.message ?? error}`,
          );
        }
      }
    }

    if (anySucceeded) {
      return { ok: true };
    }

    // Only surface subscriptionGone when the single subscription we had
    // died — with multiple subscriptions a mix of failure reasons doesn't
    // mean the user has no reachable device, just that this attempt failed.
    const soleSubscriptionDied = subscriptions.length === 1 && goneCount === 1;
    return soleSubscriptionDied
      ? { ok: false, subscriptionGone: true }
      : { ok: false };
  }
}
