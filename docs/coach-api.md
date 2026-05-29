# Coach API

The Coach API is a Socratic productivity layer built on user-provided LLM keys (BYOK). All routes are mounted under the global `/api` prefix and require a valid Supabase JWT in `Authorization: Bearer <token>` unless explicitly stated otherwise.

- **Base URL:** `/api`
- **Auth:** JWT bearer on every endpoint
- **Content type:** `application/json` for all routes except SSE (`text/event-stream`)
- **Errors:** Standard NestJS shape — `{ statusCode, message, error }`

## Common status codes

| Code | When |
|------|------|
| 200 | OK |
| 201 | Created (POST upserts that produced a new row) |
| 400 | Validation failure (class-validator pipe) |
| 401 | Missing / invalid JWT |
| 404 | Resource not found (including cross-user lookups — existence is never leaked) |
| 412 | Precondition failed — BYOK key not configured (AI endpoints only) |
| 429 | Per-user throttle (30 AI POSTs / 24h) **or** monthly token budget exceeded |
| 500 | Unhandled server error |

## Enums

```ts
enum CoachProvider { OPENAI, ANTHROPIC }
enum CoachScope    { NARRATIVE, CHAT }
enum CoachRole     { USER, ASSISTANT, SYSTEM_NARRATIVE }
```

---

## BYOK

Manage the encrypted LLM provider key. The raw key is encrypted at rest with AES-256-GCM using `BYOK_ENCRYPTION_KEY` and **never returned in any response** — only a masked hint such as `sk-ant-...A4f9`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/api/coach/byok-key`        | JWT | Current key state for the user |
| POST   | `/api/coach/byok-key`        | JWT | Save or rotate the key (idempotent: rotation overwrites) |
| DELETE | `/api/coach/byok-key`        | JWT | Delete the key (idempotent) |
| GET    | `/api/coach/byok-key/usage`  | JWT | Token usage for the current 30-day window |

### POST /api/coach/byok-key

Request:
```json
{ "provider": "OPENAI" | "ANTHROPIC", "apiKey": "sk-..." }
```

| Field | Type | Constraints |
|-------|------|-------------|
| `provider` | enum | `OPENAI` or `ANTHROPIC` |
| `apiKey` | string | min 8 chars; must start with `sk-` (OpenAI) or `sk-ant-` (Anthropic) |

Response: `ByokStateDto` (see below)

| Status | Meaning |
|--------|---------|
| 200 | Saved / rotated |
| 400 | Wrong prefix for provider, or key too short |
| 401 | Missing JWT |

### GET /api/coach/byok-key

Response (`ByokStateDto`):
```json
{
  "status": "unset" | "active",
  "provider": "OPENAI" | "ANTHROPIC" | null,
  "maskedKey": "sk-ant-...A4f9" | null,
  "tokensUsed": 1234 | null,
  "tokensLimit": 100000 | null
}
```

### DELETE /api/coach/byok-key

Response: `{ "success": true }`. Returns 200 whether the key existed or not.

### GET /api/coach/byok-key/usage

Response (`UsageDto`):
```json
{ "tokensUsed": 1234, "tokensLimit": 100000, "windowStart": "2026-05-01T00:00:00.000Z" }
```

`tokensLimit` defaults to `100000` per 30-day window. Window auto-resets server-side on the next AI request after 30 days. 404 if no key is configured.

---

## Habits Profile

Per-user freeform profile that feeds the Coach context bundle.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/coach/habits-profile` | JWT | Get profile (returns defaults inline if unset — does **not** persist) |
| PUT | `/api/coach/habits-profile` | JWT | Upsert profile (partial fields allowed) |

### PUT /api/coach/habits-profile

Request (all fields optional):

| Field | Type | Constraints |
|-------|------|-------------|
| `why` | string | ≤ 4000 chars |
| `phoneBlockerInstalled` | boolean | |
| `distractingSubsCancelled` | boolean | |
| `websiteBlockerUrls` | string | ≤ 4000 chars |
| `sleepTargetHours` | int | 1..16 |
| `bedtime` | string | `HH:MM` 24h |
| `wakeTime` | string | `HH:MM` 24h |
| `workEnvironment` | string | ≤ 4000 chars |
| `additionalContext` | string | ≤ 8000 chars |

Response (`HabitsProfileDto`): same fields plus `id`, `userId`, `createdAt`, `updatedAt`.

---

## Daily Check-ins

One check-in per (user, date).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/coach/checkins` | JWT | List check-ins (default: last 30 days) |
| GET | `/api/coach/checkins/today` | JWT | Today's check-in for the server timezone, or `null` |
| POST | `/api/coach/checkins` | JWT | Upsert a check-in on `[userId, date]` (idempotent) |

### GET /api/coach/checkins

Query (`ListCheckinsDto`):

| Param | Type | Constraints |
|-------|------|-------------|
| `from` | string | `YYYY-MM-DD` (optional, defaults to 30 days ago) |
| `to`   | string | `YYYY-MM-DD` (optional, defaults to today) |

Response: `DailyCheckin[]`.

### POST /api/coach/checkins

Request (`UpsertDailyCheckinDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `date` | string | `YYYY-MM-DD`, required |
| `mood` | int | 1..5, required |
| `energy` | int | 1..5, required |
| `focus` | int | 1..5, required |
| `blocked` | string | ≤ 4000 chars, optional |
| `worked` | string | ≤ 4000 chars, optional |

Response: `DailyCheckin`.

---

## Goal Reflections

Weekly reflection scoped to one goal + one ISO week. Goal ownership is enforced; missing/foreign goals return 404 without leaking existence.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/coach/goals/:goalId/reflections` | JWT | Get reflection for `weekKey` (defaults to current ISO week) |
| GET | `/api/coach/goals/:goalId/reflections/history` | JWT | Last 12 reflections for this goal, newest first |
| POST | `/api/coach/goals/:goalId/reflections` | JWT | Upsert reflection on `[userId, goalId, weekKey]` (idempotent) |

### GET /api/coach/goals/:goalId/reflections

Query:

| Param | Type | Constraints |
|-------|------|-------------|
| `weekKey` | string | `YYYY-Www` e.g. `2026-W22`, optional |

Response: `GoalReflection` or `null` if none for that week.

### POST /api/coach/goals/:goalId/reflections

Request (`UpsertGoalReflectionDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `weekKey` | string | `YYYY-Www`, required |
| `feel` | int | 1..5, required |
| `worked` | string | ≤ 4000 chars, optional |
| `blocked` | string | ≤ 4000 chars, optional |
| `nextWeekFocus` | string | ≤ 4000 chars, optional |

Response: `GoalReflection`. 404 if `goalId` does not exist or is not owned by the user.

---

## Journal

Rich-text TipTap journal with optional mood/energy on each entry. One entry per (user, date).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/api/coach/journal/entries`                | JWT | List entries (default: last 60 days) |
| GET    | `/api/coach/journal/entries/:date`          | JWT | Single entry by date |
| POST   | `/api/coach/journal/entries`                | JWT | Upsert entry on `[userId, date]` (idempotent) |
| PUT    | `/api/coach/journal/entries/:date/content`  | JWT | Set HTML content (upserts if missing) |
| PUT    | `/api/coach/journal/entries/:date/mood`     | JWT | Set mood/energy (upserts if missing) |
| DELETE | `/api/coach/journal/entries/:date`          | JWT | Delete entry (idempotent — 200 even if absent) |

The `:date` path segment is regex-constrained to `\d{4}-\d{2}-\d{2}`; malformed dates yield 404 from the router (not 400).

### GET /api/coach/journal/entries

Query:

| Param | Type | Constraints |
|-------|------|-------------|
| `from` | string | `YYYY-MM-DD`, optional (defaults to 60 days ago) |
| `to`   | string | `YYYY-MM-DD`, optional (defaults to today) |

Response: `JournalEntry[]`.

### POST /api/coach/journal/entries

Request (`UpsertJournalEntryDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `date` | string | `YYYY-MM-DD`, required |
| `mood` | int | 1..5, optional |
| `energy` | int | 1..5, optional |
| `content` | string | ≤ 65535 chars (TipTap HTML), optional |

### PUT /api/coach/journal/entries/:date/content

Request (`UpdateJournalContentDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `content` | string | required, ≤ 65535 chars (may be empty string) |

### PUT /api/coach/journal/entries/:date/mood

Request (`UpdateJournalMoodDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `mood` | int \| null | 1..5 or explicit `null` |
| `energy` | int \| null | 1..5 or explicit `null` |

### DELETE /api/coach/journal/entries/:date

Response: `{ "success": true }`. Always 200.

---

## Coach AI

Streaming Socratic responses via Server-Sent Events. Backed by the user's BYOK key; routed through an `LlmFactory` so OpenAI (`gpt-4o-mini`) and Anthropic (`claude-3-5-haiku-20241022`) are interchangeable behind a single interface.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET  | `/api/coach/narrative/:scopeKey` | JWT | Return the cached narrative for `scopeKey` (an ISO week like `2026-W22`) |
| POST | `/api/coach/narrative/:scopeKey` | JWT | **SSE.** Stream a weekly narrative; cached unless `?force=true` |
| GET  | `/api/coach/chat/:scopeKey`      | JWT | Full chat history for the scope (default: `[]`) |
| POST | `/api/coach/chat/:scopeKey`      | JWT | **SSE.** Stream a chat reply (USER message persisted before stream opens) |

### Throttling

POST endpoints are wrapped by `UserThrottlerGuard` keyed on `req.user.sub`:

- **30 requests per rolling 24 hours per user** → 429 on overflow.
- Additionally each AI call decrements the per-user monthly token budget held in `EncryptedByokKey.tokensUsedThisMonth`. When the cumulative total reaches `tokensLimit` (default 100,000 per 30 days), the next request returns 429 with `{ tokensUsed, tokensLimit }` in the body. The window auto-resets server-side after 30 days.
- The narrative cache (existing message for the same `scopeKey`) is served without invoking the provider or counting against the budget.

### Errors specific to AI endpoints

| Status | Body | Meaning |
|--------|------|---------|
| 404 | `{ statusCode: 404, message: 'No narrative cached' }` | GET narrative when nothing has been generated yet |
| 412 | `{ statusCode: 412, message: 'BYOK key not configured' }` | POST narrative/chat without a saved BYOK key |
| 429 | `{ statusCode: 429, message: 'ThrottlerException', ... }` | Per-user rate limit (30/24h) hit |
| 429 | `{ statusCode: 429, message: 'Monthly token budget exceeded', tokensUsed, tokensLimit }` | Token budget hit |

### POST /api/coach/chat/:scopeKey

Request (`ChatMessageDto`):

| Field | Type | Constraints |
|-------|------|-------------|
| `content` | string | 1..2000 chars, required |

The user message is persisted to `CoachMessage` **before** the LLM stream opens so a mid-stream disconnect/retry never drops the user's input.

### SSE protocol

All streaming POSTs respond with:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

Each event uses the NestJS `@Sse()` envelope. The `data:` payload is a JSON object:

```ts
{
  data: {
    delta: string;        // incremental text — accumulate client-side
    done: boolean;        // true on the terminal frame
    usage?: { promptTokens: number; completionTokens: number };
    error?: string;       // present only on terminal-error frames; delta is ""
  }
}
```

Example stream:

```
data: {"delta":"Let's","done":false}

data: {"delta":" look at","done":false}

data: {"delta":" your week.","done":false}

data: {"delta":"","done":true}
```

Error frames terminate the stream cleanly (`done: true`) rather than closing the socket. A complete assistant message is persisted to `CoachMessage` with `role = ASSISTANT` (chat) or `role = SYSTEM_NARRATIVE` (narrative) along with `promptTokens`, `completionTokens`, and `model`. The `EncryptedByokKey.tokensUsedThisMonth` counter is incremented in the same transaction.

### Narrative caching

`GET /api/coach/narrative/:scopeKey` returns the latest persisted assistant/narrative message for that scope, or 404. `POST` with no `force` flag will short-circuit and re-emit the cached content as a single SSE chunk; pass `?force=true` (or `?force=1`) to bypass the cache and re-generate.

### Security note

The decrypted BYOK key is captured into a local variable **before** the provider stream opens, so a concurrent `DELETE /api/coach/byok-key` cannot pull the key out from under an in-flight request. The decrypted bytes never appear in logs.
