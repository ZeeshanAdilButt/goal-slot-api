import { NotificationType } from '@prisma/client';

import { ReminderChannelKind } from './reminder-channel.interface';

// The mobile app (read-only context, lives in the other repo) lazily
// creates exactly three Android notification channels: an alarm channel
// for time-boxed schedule alerts (MAX importance), an ongoing timer
// channel (LOW, no sound - it's a persistent status notification, not an
// alert), and this one - the general "something happened" notify channel
// (DEFAULT importance, sound). Every NotificationType this API dispatches
// through ReminderDispatchService is a "something happened" notification,
// never a schedule alarm or a timer status update, so this is the one
// Android channel ID a server-sent push should ever carry. Kept as a
// string constant rather than an enum since it has to byte-match the
// channel ID string the mobile app already shipped - this is a cross-repo
// contract, not a value this API defines.
export const ANDROID_NOTIFY_CHANNEL_ID = 'goalslot-schedule-notify-v1';

// How a channel should present a push for a given NotificationType. Kept
// separate from ReminderChannelInput's `data` (routing payload) - this is
// about how the OS presents the notification, not where a tap goes.
export interface NotificationPushPresentation {
  // Expo's `sound` field. 'default' plays the platform's standard
  // notification sound; every NotificationType below wants that - a silent
  // banner is exactly the bug item 1 fixes. A future genuinely-silent
  // notification type would set this to null explicitly rather than
  // omitting sound the way the channel used to.
  sound: 'default' | null;
  channelId: typeof ANDROID_NOTIFY_CHANNEL_ID;
  // FCM/APNs delivery priority. 'high' is what beats Android's Doze-mode
  // batching - worth spending for a message that is waiting on a reply
  // right now. Everything else here is a nudge the user will see whenever
  // their phone next wakes up anyway, so 'default' (batched, battery
  // friendly) is the right tradeoff rather than spending high-priority
  // budget on it.
  priority: 'default' | 'normal' | 'high';
}

// Which delivery channels a NotificationType is allowed to fan out to.
// A Record<ReminderChannelKind, boolean> rather than an array of kinds on
// purpose: adding a new ReminderChannelKind (e.g. 'sms') later forces every
// existing policy entry below to be updated with an explicit true/false for
// it, which is a compile error until it happens. An array would let a new
// channel kind silently default to "never attempted" for every existing
// notification type with no signal that a decision was skipped.
export type NotificationChannelPolicy = Record<ReminderChannelKind, boolean>;

export interface NotificationPolicy {
  channels: NotificationChannelPolicy;
  push: NotificationPushPresentation;
}

const NUDGE_PUSH: NotificationPushPresentation = {
  sound: 'default',
  channelId: ANDROID_NOTIFY_CHANNEL_ID,
  priority: 'default',
};

const URGENT_PUSH: NotificationPushPresentation = {
  sound: 'default',
  channelId: ANDROID_NOTIFY_CHANNEL_ID,
  priority: 'high',
};

// Fallback for a send that doesn't carry a `notificationType` at all (an
// old/direct caller predating this field - see ReminderChannelInput).
// Matches the routine-nudge treatment: better to under-prioritize an
// unknown notification than to spend high-priority budget speculatively.
export const DEFAULT_PUSH_PRESENTATION: NotificationPushPresentation =
  NUDGE_PUSH;

// The compile-time-exhaustive NotificationType -> policy map. Assigning an
// object literal to Record<NotificationType, ...> requires every enum
// member to have an entry, so adding a NotificationType in schema.prisma
// without adding a line here is a compile error, not a silent "no policy
// found" at runtime - see ReminderDispatchService.dispatchToUser, which
// filters REMINDER_CHANNELS through this before fan-out.
export const NOTIFICATION_POLICY: Record<NotificationType, NotificationPolicy> =
  {
    // A chat message is the one notification type here with someone on the
    // other end actively waiting on a reply. Email would arrive minutes to
    // hours later, long after the WebSocket-connected conversation has
    // moved on - not worth sending at all, let alone unconditionally on
    // every message the way the channel used to. Push only, high priority.
    [NotificationType.MESSAGE_RECEIVED]: {
      channels: { email: false, push: true },
      push: URGENT_PUSH,
    },

    // Daily/cron-driven nudges: nothing is waiting on these being seen
    // within seconds, so default priority (batched, battery friendly) is
    // the right tradeoff, and email is worth sending alongside push since
    // a mentor/mentee may not have push configured on any device yet.
    [NotificationType.SHARED_REPORT_UNVIEWED]: {
      channels: { email: true, push: true },
      push: NUDGE_PUSH,
    },
    [NotificationType.INSTRUCTION_ASSIGNED]: {
      channels: { email: true, push: true },
      push: NUDGE_PUSH,
    },

    // A new build was published. Not urgent (nobody is waiting on it the
    // way a chat reply is), so default priority — but worth email too,
    // since a user who's stepped away from the app for a while (exactly
    // who benefits from being told an update is out) may not have push
    // reliably configured.
    [NotificationType.APP_RELEASE]: {
      channels: { email: true, push: true },
      push: NUDGE_PUSH,
    },

    // Never goes through ReminderDispatchService today - NotificationsService
    // writes the in-app Notification row directly and nothing else (see
    // src/modules/notifications/notifications.service.ts). Given an explicit
    // no-channels entry rather than left out, both to satisfy the exhaustive
    // Record above and to document that this is the current behavior on
    // purpose, not an oversight.
    [NotificationType.FEEDBACK_REPLY]: {
      channels: { email: false, push: false },
      push: NUDGE_PUSH,
    },
  };
