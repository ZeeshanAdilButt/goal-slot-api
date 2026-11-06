# Projects inside Tasks: design

Date: 2026-11-06
Status: approved by owner ("let's implement this"), v1 scope below
Design canvas: https://claude.ai/artifact/Wj1APgQy4sTR9qLcdqGxt4 (Tasks switcher open, My tasks, Task detail, Invite)

## Purpose

Replace Linear for small teams. A project is a shared space of tasks inside the existing Tasks tab. A dropdown at the top of Tasks switches between "My tasks" (today's personal view) and each project. The board, list, statuses (BACKLOG, TODO, DOING, DONE), estimates, due dates, timer and time logging all stay the same; a project adds members, roles, invites and assignees.

## Non-negotiables

- Personal tasks behave exactly as today. A user who never creates or joins a project sees no change, and the mobile app (which calls GET /tasks with no new params) keeps working unchanged.
- Nobody ever sees another user's personal tasks, goals, schedule or time entries through a project.
- Every project read and write checks membership server side. Never trust a projectId or assigneeId from the client.

## Data model (Prisma, one migration)

```prisma
enum ProjectRole { ADMIN MEMBER GUEST }

model Project {
  id          String   @id @default(uuid())
  name        String
  color       String   @default("#2563EB")
  description String?
  createdById String
  createdBy   User     @relation("ProjectsCreated", fields: [createdById], references: [id], onDelete: Cascade)
  archivedAt  DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  members     ProjectMember[]
  invites     ProjectInvite[]
  tasks       Task[]
  @@index([createdById])
}

model ProjectMember {
  id        String      @id @default(uuid())
  projectId String
  project   Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  userId    String
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  role      ProjectRole @default(MEMBER)
  joinedAt  DateTime    @default(now())
  @@unique([projectId, userId])
  @@index([userId])
}

model ProjectInvite {
  id          String      @id @default(uuid())
  projectId   String
  project     Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  email       String?     // null = shareable link invite
  role        ProjectRole @default(MEMBER)
  token       String      @unique
  expiresAt   DateTime
  invitedById String
  invitedBy   User        @relation("ProjectInvitesSent", fields: [invitedById], references: [id], onDelete: Cascade)
  acceptedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime    @default(now())
  @@index([projectId])
  @@index([email])
}
```

Task gains:

```prisma
  projectId  String?
  project    Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)
  assigneeId String?
  assignee   User?    @relation("TasksAssigned", fields: [assigneeId], references: [id], onDelete: SetNull)
  @@index([projectId, status])
  @@index([assigneeId])
```

`Task.userId` stays and means "created by". Project tasks are deleted with their project (TimeEntry.taskId is already SetNull, so logged time survives).

## Permissions

| Action | ADMIN | MEMBER | GUEST | Non-member |
|---|---|---|---|---|
| See project, its tasks, members | yes | yes | yes | 404 |
| Create, edit, move, complete, assign tasks; log time on them | yes | yes | no (403) | 404 |
| Delete a task | yes | only tasks they created | no | 404 |
| Rename, recolor, archive, delete project | yes | no | no | 404 |
| Invite, revoke invites, change roles, remove members | yes | no | no | 404 |
| Leave project | yes, unless the last ADMIN | yes | yes | n/a |

- Creator becomes ADMIN. The last ADMIN can neither leave nor be demoted or removed.
- Removing or leaving a member unassigns their assigned tasks in that project.
- Use 404 (not 403) for non-members so project ids cannot be probed.
- Caps: 50 projects created per user, 50 members per project, 30 pending email invites per project.

## Goals on project tasks (v1 rule)

Goals stay personal. A project task's `goalId` may be set only by the task's creator, to one of the creator's own goals (existing validateRelations). The task response includes `goal` only when the requester owns that goal; other members get `goal: null`. Time a member logs on a project task carries that member's own optional goalId on the TimeEntry, as today. Goal progress updates on complete only when the goal belongs to the acting user. In project mode the board's left sidebar filters by member instead of goal.

## API

Projects module (`src/modules/projects`), all JWT-guarded:

- `POST /projects` {name, color?, description?} -> project with `role: ADMIN`
- `GET /projects` -> projects I belong to (not archived): {id, name, color, role, memberCount, openTaskCount}
- `GET /projects/:id`, `PATCH /projects/:id` (ADMIN), `DELETE /projects/:id` (ADMIN)
- `GET /projects/:id/members` -> [{userId, name, email, avatar, role, joinedAt}] (email visible to ADMIN only)
- `PATCH /projects/:id/members/:userId` {role} (ADMIN), `DELETE /projects/:id/members/:userId` (ADMIN, or self to leave)
- `POST /projects/:id/invites` {emails: string[1..20], role} (ADMIN): one invite per email, 7-day expiry, sends `EmailService.sendProjectInvitation` (new, same layout as sendShareInvitation, link `${appUrl}/projects/invite?token=...`). Existing members are skipped and reported. Re-inviting a pending email refreshes its token and expiry.
- `POST /projects/:id/invite-link` {role?: MEMBER|GUEST} (ADMIN): creates or returns the current link invite (email null, 7-day expiry, multi-use); `DELETE /projects/:id/invite-link` revokes it.
- `GET /projects/:id/invites` (ADMIN), `POST /projects/:id/invites/:inviteId/resend`, `DELETE /projects/:id/invites/:inviteId`
- `GET /projects/invites/:token` (JWT) -> {projectName, color, inviterName, role, expired, alreadyMember}
- `POST /projects/invites/:token/accept` (JWT): an email invite only accepts when the signed-in user's email matches (case-insensitive), else 403 with a clear message; a link invite accepts for anyone signed in. Expired or revoked -> 410. Creates membership, sets acceptedAt (email invites only).

Tasks (extend existing, keep every current behaviour):

- `GET /tasks` new optional params:
  - `scope=mine` (DEFAULT when no projectId, so mobile is unchanged in spirit): personal tasks I created, plus any project task assigned to me, plus project tasks I created that are unassigned.
  - `scope=personal`: only `userId = me AND projectId IS NULL`.
  - `projectId=<id>` (membership required): all tasks in the project. Optional `assignee=me|unassigned|<userId>`.
  - Existing filters (status, statuses, goalId, scheduleBlockId, dayOfWeek) still apply. goalId filter only matches goals the requester owns.
- Task responses gain `project: {id, name, color} | null` and `assignee: {id, name, avatar} | null`, and `canEdit: boolean`.
- `POST /tasks` accepts `projectId?`, `assigneeId?` (assignee must be a member of that project; assignee without projectId is 400).
- `PUT /tasks/:id` accepts `assigneeId` (null to unassign) and `projectId` (the creator may move a personal task into a project they can write to, or back to personal; moving clears assigneeId when it no longer applies).
- findOne, update, complete, restore, reorder, delete: replace `where: {id, userId}` with one shared `assertTaskAccess(userId, taskId, 'read' | 'write' | 'delete')` helper that applies the table above. Reorder stays per-user for personal tasks; for a project board, reorder requires write access and only reorders tasks in that project.
- Time entries and active timer: where they validate `task.findFirst({ id: taskId, userId })`, accept a task the user can write (personal owner, or ADMIN/MEMBER of its project). Tests for a member logging time on another member's project task, and a guest being refused.
- Reports, coach, templates and categories keep reading by userId and must not start returning other users' tasks. Add a regression test that the coach context and reports for user A never include user B's project tasks.

## Web (goal-slot-web)

- Tasks page header: the title becomes a switcher (button with aria-haspopup="menu"). Menu: search, "My tasks" (count), Projects list (color, open count, Guest tag, check on current), "New project", "Project settings and members". Keyboard: P opens it. The selection lives in the URL (`/dashboard/tasks?project=<id>`), so links and refresh work.
- My tasks: today's page plus project tasks assigned to me, each card showing a small project chip in the project color. Toggle "Mine + assigned" / "Personal only" (maps to scope=mine / scope=personal).
- Project mode: members avatar stack, Invite button (ADMIN), same Board/List, filter chips Everyone / Assigned to me / Unassigned / Due this week, assignee avatar on each card, left sidebar = members filter. Guests see everything read-only (no drag, no New Task, no edit).
- Create and edit task modal: Project select (My tasks or a project you can write to) and Assignee select (members of that project).
- New project dialog: name, color swatches.
- Project settings dialog: rename, color, members with role select and remove, Leave project, Delete project (typed confirmation).
- Invite dialog per the canvas: email chips, role radio (Admin, Member, Guest with descriptions), invite link with copy and role, pending invites with resend and revoke.
- Accept page `/projects/invite?token=`: shows project, inviter and role; Accept / Decline; if signed out, sign in or sign up then return here; wrong-email and expired states explained in plain words. Wrap the search-params reader in Suspense (Next 16 prerender rule).
- TanStack Query keys: ['projects'], ['projects', id, 'members'], ['tasks', {scope|projectId,...}]. Invalidate both the project board and My tasks after task mutations. No new polling.

## Out of scope for v1 (follow-ups)

Comments and activity log, subtasks, project goals, notifications and push for assignments, mobile UI for projects (mobile keeps working via scope=mine), cycles, custom statuses.

## Testing

- API: unit tests for the permission table (every role x action), invite accept (email match, link invite, expired, revoked, already member), last-admin rules, task scope queries, time entry on project task, and the no-leak regression tests above. Full suite green, tsc clean.
- Web: vitest for the switcher state, scope mapping and the invite dialog validation; tsc and eslint clean.
