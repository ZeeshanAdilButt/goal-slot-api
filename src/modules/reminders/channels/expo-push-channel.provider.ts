import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  ReminderChannel,
  ReminderChannelInput,
  ReminderChannelResult,
} from '../reminder-channel.interface';

@Injectable()
export class ExpoPushReminderChannel implements ReminderChannel {
  readonly name = 'expo-push';

  private readonly logger = new Logger(ExpoPushReminderChannel.name);
  private readonly expo = new Expo();

  constructor(private readonly prisma: PrismaService) {}

  // Mobile push has no separate "gone" query the way web push has a 410 -
  // Expo reports it inline as a ticket with status 'error' and
  // details.error === 'DeviceNotRegistered'. That is the direct analog of
  // web push's 410, so it triggers the same "stop retrying this endpoint"
  // handling: delete the row so tomorrow's sweep does not resend to it.
  //
  // Every branch below resolves rather than throws - the orchestrator sweeps
  // every user independently and treats a thrown error as a bug in the
  // channel, not a delivery failure, so any failure here (SDK network error,
  // malformed tokens, a bad delete) resolves to { ok: false } instead of
  // propagating and stopping the sweep for the next user.
  async send(input: ReminderChannelInput): Promise<ReminderChannelResult> {
    try {
      const subscriptions = await this.prisma.pushSubscription.findMany({
        where: { userId: input.userId, kind: 'EXPO' },
      });

      if (subscriptions.length === 0) {
        return { ok: false };
      }

      // A stored token can be malformed (device re-registered under a
      // different scheme, manual DB edit, etc). Expo's SDK does not return a
      // ticket for a syntactically invalid token - it never gets sent, so
      // it has to be filtered out up front rather than treated as a delivery
      // failure.
      const validSubscriptions = subscriptions.filter(
        (subscription) =>
          typeof subscription.expoToken === 'string' &&
          Expo.isExpoPushToken(subscription.expoToken),
      );

      if (validSubscriptions.length === 0) {
        return { ok: false };
      }

      const messages: ExpoPushMessage[] = validSubscriptions.map(
        (subscription) => ({
          to: subscription.expoToken as string,
          title: input.title,
          body: input.body,
          data: input.data,
        }),
      );

      // Each message here has a single string `to`, not an array, so
      // chunkPushNotifications only groups them into batches - it never
      // splits one message across chunks. That keeps the flattened ticket
      // order aligned with validSubscriptions order below.
      const chunks = this.expo.chunkPushNotifications(messages);
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of chunks) {
        const chunkTickets = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...chunkTickets);
      }

      let anySucceeded = false;
      const deadSubscriptionIds: string[] = [];

      tickets.forEach((ticket, index) => {
        const subscription = validSubscriptions[index];

        if (ticket.status === 'ok') {
          anySucceeded = true;
          return;
        }

        if (ticket.details?.error === 'DeviceNotRegistered') {
          deadSubscriptionIds.push(subscription.id);
        } else {
          this.logger.warn(
            `Expo push ticket error for subscription ${subscription.id}: ${ticket.message}`,
          );
        }
      });

      for (const id of deadSubscriptionIds) {
        try {
          await this.prisma.pushSubscription.delete({ where: { id } });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to delete dead push subscription ${id}: ${message}`,
          );
        }
      }

      // subscriptionGone only signals when the user has been left with
      // nothing left to reach them on via this channel - if they had other
      // subscriptions, this channel still has somewhere to try next time.
      const subscriptionGone =
        subscriptions.length === 1 &&
        deadSubscriptionIds.includes(subscriptions[0].id);

      return {
        ok: anySucceeded,
        ...(subscriptionGone ? { subscriptionGone: true } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Expo push send failed for userId=${input.userId}: ${message}`,
      );
      return { ok: false };
    }
  }
}
