import { NotificationType } from '@prisma/client';

import {
  ANDROID_NOTIFY_CHANNEL_ID,
  DEFAULT_PUSH_PRESENTATION,
  NOTIFICATION_POLICY,
} from './notification-policy';

describe('NOTIFICATION_POLICY', () => {
  // The type system already enforces this (assigning an object literal to
  // Record<NotificationType, NotificationPolicy> requires every member), but
  // a runtime check catches a value silently missing after e.g. a `delete`
  // or a refactor that loses the type annotation, and documents the
  // exhaustiveness guarantee for anyone reading the tests rather than the
  // types.
  it('has an entry for every NotificationType', () => {
    const types = Object.values(NotificationType);
    for (const type of types) {
      expect(NOTIFICATION_POLICY[type]).toBeDefined();
    }
    expect(Object.keys(NOTIFICATION_POLICY).sort()).toEqual([...types].sort());
  });

  it('routes MESSAGE_RECEIVED to push only, at high priority', () => {
    const policy = NOTIFICATION_POLICY[NotificationType.MESSAGE_RECEIVED];

    expect(policy.channels).toEqual({ email: false, push: true });
    expect(policy.push.priority).toBe('high');
    expect(policy.push.sound).toBe('default');
    expect(policy.push.channelId).toBe(ANDROID_NOTIFY_CHANNEL_ID);
  });

  it.each([
    NotificationType.SHARED_REPORT_UNVIEWED,
    NotificationType.INSTRUCTION_ASSIGNED,
  ])(
    'routes %s to both email and push, at default priority',
    (notificationType) => {
      const policy = NOTIFICATION_POLICY[notificationType];

      expect(policy.channels).toEqual({ email: true, push: true });
      expect(policy.push.priority).toBe('default');
    },
  );

  // Documents current behavior on purpose: NotificationsService writes the
  // in-app row directly for feedback replies and never calls
  // ReminderDispatchService (see notifications.service.ts), so no channel
  // should be attempted for it.
  it('routes FEEDBACK_REPLY to no channel', () => {
    const policy = NOTIFICATION_POLICY[NotificationType.FEEDBACK_REPLY];

    expect(policy.channels).toEqual({ email: false, push: false });
  });

  it('every push presentation targets the general notify Android channel, never the alarm or timer channel', () => {
    for (const policy of Object.values(NOTIFICATION_POLICY)) {
      expect(policy.push.channelId).toBe('goalslot-schedule-notify-v1');
    }
  });

  it('DEFAULT_PUSH_PRESENTATION matches the routine-nudge treatment', () => {
    expect(DEFAULT_PUSH_PRESENTATION).toEqual({
      sound: 'default',
      channelId: ANDROID_NOTIFY_CHANNEL_ID,
      priority: 'default',
    });
  });
});
