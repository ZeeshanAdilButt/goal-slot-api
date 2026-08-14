import { NotificationType } from '@prisma/client';

// The delivery mechanism a channel uses, as opposed to `name` which
// identifies the specific provider (there are two push providers - Expo
// and web push - sharing the 'push' kind). NotificationPolicy filters
// REMINDER_CHANNELS by this before fan-out, so every channel has to
// declare one.
export type ReminderChannelKind = 'email' | 'push';

// A single delivery channel a reminder can go out through. Each channel
// (email, web push, Expo push) implements this the same way, so the
// dispatcher can run all of them without knowing which ones exist.
export interface ReminderChannel {
  readonly name: string;
  readonly kind: ReminderChannelKind;

  send(input: ReminderChannelInput): Promise<ReminderChannelResult>;
}

export interface ReminderChannelInput {
  userId: string;
  title: string;
  body: string;
  // Carries enough context for the client to route a tap somewhere specific,
  // e.g. { type: 'schedule', sharedAccessId } or { type: 'instruction', instructionId }.
  data?: Record<string, unknown>;
  // Which NotificationType this send is for, so a channel can look up its
  // presentation (sound/channelId/priority - see notification-policy.ts)
  // without every caller having to compute and pass that itself. Optional
  // rather than required: existing inline `channel.send({...})` call sites
  // (tests, and any future direct caller) predate this field, and a channel
  // without it just falls back to DEFAULT_PUSH_PRESENTATION.
  notificationType?: NotificationType;
}

export interface ReminderChannelResult {
  ok: boolean;
  // Set when the channel confirms the underlying subscription/token is dead
  // (a web push 410, an Expo DeviceNotRegistered ticket) so the caller knows
  // to stop retrying it. Omitted or false otherwise.
  subscriptionGone?: boolean;
}

// Multi-provider injection token: RemindersModule collects every registered
// ReminderChannel provider under this token and hands the array to
// ReminderDispatchService, so adding a new channel later means adding one
// provider, not editing the dispatcher.
export const REMINDER_CHANNELS = 'REMINDER_CHANNELS';
