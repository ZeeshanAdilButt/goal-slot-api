# Mentee engagement reminders design

Date: 2026-08-11
Status: approved, pending implementation plan

## Purpose

Mentors who have accepted access to a mentee's shared reports currently have
no signal telling them to go check in. A mentor can go stale on a mentee
indefinitely with nothing prompting them back. Separately, a mentor has no
way to hand a mentee something to do that is distinct from the mentee's own
task list — something the mentee is expected to act on because their mentor
asked, not because they planned it themselves.

This spec covers two features that share one underlying mechanism:

1. Remind a mentor when they have not looked at a mentee's report in
   7 days.
2. Let a mentor assign an "instruction" to a mentee, visible on the
   mentee's dashboard, with recurring reminders until it is marked done.

Explicitly out of scope: the mentor-mentee messaging service. That is being
designed and built separately as its own repository (`jiffy-messaging`).

## Why one shared mechanism

Both features reduce to the same shape: on a schedule, find records that
have gone stale against some threshold, and for each one, notify a specific
user across every channel they can be reached on. Building two parallel
notification paths — one for report staleness, one for instructions — would
mean two places that can drift out of sync on retry logic, channel
fan-out, and failure handling. This spec defines one reminder dispatch
path and feeds it two trigger sources.

## Scope of the UI

The mentor-side "view a mentee's report" flow and the mentee-mentor sharing
relationship exist today only in `dw-time-web` (`SharedReportsView` and the
`sharing` feature). No mobile-side sharing UI exists. This spec builds the
web UI for both features — the mentor's assign/view surfaces and the
mentee's dashboard section for received instructions. The API is built
platform-agnostic so a mobile UI can consume the same endpoints later; no
mobile screens are part of this spec.

## Data model

Three additions to `dw-time-api/prisma/schema.prisma`.

### SharedAccess (existing model, two new fields)

```prisma
lastViewedAt       DateTime?
lastViewReminderAt DateTime?
```

`lastViewedAt` is set the moment a mentor opens that mentee's report view —
any view counts, there is no minimum dwell time. `lastViewReminderAt`
records when a staleness reminder last fired for this share, so the sweep
can nudge once per week of staleness rather than once per day.

### Instruction (new model)

```prisma
model Instruction {
  id             String    @id @default(uuid())

  assignerId     String
  assigner       User      @relation("InstructionsAssigned", fields: [assignerId], references: [id], onDelete: Cascade)

  assigneeId     String
  assignee       User      @relation("InstructionsReceived", fields: [assigneeId], references: [id], onDelete: Cascade)

  title          String
  note           String?

  status         String    @default("PENDING") // PENDING | DONE
  completedAt    DateTime?

  lastReminderAt DateTime?

  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([assigneeId, status])
  @@index([assignerId])
}
```

An instruction is a standalone record, not a row in the existing `Task`
table with a flag on it. It has its own list, its own completion action,
and its own reminder cadence, and mixing it into `Task` would mean every
existing task query has to filter it back out. Assigning one does not
modify any of the mentee's own data.

### PushSubscription (new model)

```prisma
model PushSubscription {
  id        String   @id @default(uuid())

  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  kind      String   // "WEB" | "EXPO"

  // WEB
  endpoint  String?
  p256dh    String?
  auth      String?

  // EXPO
  expoToken String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, endpoint])
  @@unique([userId, expoToken])
  @@index([userId])
}
```

One row per device or browser. Postgres treats NULL as distinct in a
unique index, so a user can have any number of WEB rows (each with a
distinct endpoint, null expoToken) alongside any number of EXPO rows
(each with a distinct expoToken, null endpoint) without the unique
constraints colliding with each other.

## Permissions

Assigning an instruction requires an accepted `SharedAccess` row where the
assigner is the `sharedWith` side and the assignee is the `owner` side —
the same direction as viewing reports. It does not check `accessLevel`
(VIEW vs EDIT). Assigning an instruction does not modify the mentee's
existing goals, tasks, or schedule; it creates a new record the mentee
sees separately, so it is not gated behind the same permission that
governs editing a mentee's own data.

## Reminder dispatch

### Trigger sources

Two queries, run daily:

- **Report staleness**: every accepted `SharedAccess` where `lastViewedAt`
  is null or older than 7 days, and `lastViewReminderAt` is null or older
  than 7 days. The second condition is what turns this into a weekly
  recurring nudge instead of a daily one once a share is stale.
- **Pending instructions**: every `Instruction` with `status = PENDING`
  where `lastReminderAt` is null or older than 2 days.

### Channels

For each hit, the dispatcher sends to the target user (the mentor for
report staleness, the mentee for instructions) across:

- **Email** — via the existing `EmailService`. Always attempted; every
  user has an email address on file.
- **Mobile push** — via Expo's push API, using any `EXPO` kind
  `PushSubscription` rows for that user. Only attempted if the user has
  at least one registered token.
- **Web push** — via the `web-push` package and VAPID keys, using any
  `WEB` kind `PushSubscription` rows for that user. Only attempted if the
  user has at least one registered subscription.
- **In-app** — a real `Notification` model and service already exist
  (`notifications.service.ts`, consumed by `NotificationsButton` in
  `dw-time-web`), with a `NotificationType` enum, cursor pagination, an
  unread count, and mark-read. This was not known when the shared
  mechanism above was first drafted; reusing it is a better fit than
  inventing a live-state query, and the existing bell UI picks up the two
  new types automatically since it renders `title`/`body` generically.
  Two new `NotificationType` values are added:
  `SHARED_REPORT_UNVIEWED` and `INSTRUCTION_ASSIGNED`.

There is no per-channel opt-in in this version — every channel with data
to reach the user on is used. A preference system is a reasonable future
addition, not part of this spec.

### Failure handling

Each user's dispatch is wrapped independently within the daily sweep — one
user's email failing does not stop the sweep from reaching the next user,
and one channel failing does not stop the other channels for the same
user. A push send that fails because the subscription is gone (web push
410, Expo `DeviceNotRegistered`) deletes that `PushSubscription` row so
the sweep stops retrying a dead endpoint. Any other failure is logged and
left for the next day's sweep to retry naturally — `lastReminderAt` /
`lastViewReminderAt` are only advanced after at least one channel
succeeds, so a fully failed dispatch does not silently stop trying.

### Cron

No scheduled-job infrastructure exists in the API today. This adds
`@nestjs/schedule` and a single daily job. Existing cron-style patterns to
follow: none — this is the first one, so it sets the pattern (a small
`ReminderCronService` with one `@Cron` method that delegates to a plain,
independently testable `ReminderDispatchService`).

## API surface

- `POST /sharing/:sharedAccessId/mark-viewed` — mentor marks a mentee's
  report viewed. Sets `lastViewedAt`.
- `POST /instructions` — assign an instruction. Body: `assigneeId`,
  `title`, `note?`. Verifies the accepted-share direction above.
- `GET /instructions/assigned-by-me` — mentor's sent list with status.
- `GET /instructions/assigned-to-me` — mentee's received list.
- `PATCH /instructions/:id/complete` — mentee marks done. Verifies the
  caller is the assignee.
- `POST /push-subscriptions` — register a web or Expo subscription.
- `DELETE /push-subscriptions/:id` — unregister.

## Testing

- Staleness/due logic (the "is this old enough to remind" check for both
  trigger sources) as pure functions over fixed dates — no database, no
  clock mocking beyond passing `now` in.
- Dispatch fan-out with each channel sender mocked, covering: all
  channels succeed, one channel fails and the others still run, a push
  send returns "gone" and the subscription row is deleted, no channels
  configured beyond email.
- Permission check for instruction assignment: accepted share in the
  right direction succeeds, wrong direction or unaccepted share is
  rejected.
- Existing Prisma migration and API integration test conventions apply
  to the new endpoints; no new testing framework is introduced.

## Explicitly not built here

- Mentor-mentee messaging (separate spec, separate repository).
- A notification preference/opt-out system.
- Mobile UI for instructions or report viewing (API supports it; no
  mobile screens are part of this spec).
