import { NotificationType, Prisma } from '@prisma/client';

/**
 * Which slice of a user's notifications a request is talking about.
 *
 * This exists because MESSAGE_RECEIVED notifications moved out of the
 * notification bell and onto the messages icon (an IA change the user
 * asked for). The bell must therefore be able to say "everything except
 * message notifications" — and it must be able to say it *identically* on
 * the list endpoint, on that list's unread count, and on mark-all-read.
 *
 * A closed enum rather than a free-form `types` / `excludeTypes` array is
 * deliberate:
 *
 *  - Web and mobile must filter the bell the same way. An open list lets
 *    the two clients drift apart silently; one named token cannot.
 *  - `GET /notifications` and `PATCH /notifications/read-all` take the
 *    same token, which is what makes "mark all read" mean *exactly* "mark
 *    everything in the feed I am looking at" by construction, rather than
 *    by two filters that happen to agree today.
 *  - The server never hard-codes the exclusion. `all` stays the default,
 *    so this change is purely additive: already-installed clients that
 *    send no `scope` keep seeing exactly what they see today. That
 *    matters because this API deploys to production on merge while the
 *    clients ship on their own (OTA / PR) cadences — a unilateral server
 *    split would blank out message notifications on every deployed build
 *    the moment it landed.
 */
export const NOTIFICATION_SCOPES = ['all', 'general'] as const;

export type NotificationScope = (typeof NOTIFICATION_SCOPES)[number];

/**
 * Scope assumed when a request omits `scope`. MUST stay `all` — see the
 * rollout note above.
 */
export const DEFAULT_NOTIFICATION_SCOPE: NotificationScope = 'all';

/**
 * Types hidden from each scope. Typed as an exhaustive Record over
 * NotificationScope so adding a scope is a compile error until it is
 * given a rule here.
 */
const EXCLUDED_TYPES_BY_SCOPE: Record<NotificationScope, NotificationType[]> = {
  // Everything, including MESSAGE_RECEIVED. The historical behavior.
  all: [],
  // The notification bell: everything the messages icon does not already
  // account for. MESSAGE_RECEIVED rows are still written (they are the
  // push carrier and the audit trail) — they are just not this feed's.
  general: [NotificationType.MESSAGE_RECEIVED],
};

export function isNotificationScope(value: unknown): value is NotificationScope {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * The `where` fragment a scope contributes. Spread into *every* query that
 * backs a scoped surface — the list, its unread count, and mark-all-read —
 * so those three can never disagree.
 *
 * The unread count is the one that bites: a bell that lists no message
 * notifications but counts them shows a badge the user cannot clear by
 * reading anything, which is worse than the bug being fixed.
 */
export function notificationScopeFilter(
  scope: NotificationScope,
): Pick<Prisma.NotificationWhereInput, 'type'> {
  const excluded = EXCLUDED_TYPES_BY_SCOPE[scope];
  return excluded.length > 0 ? { type: { notIn: excluded } } : {};
}
