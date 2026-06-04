# GoalSlot API

The backend for [GoalSlot](https://goalslot.io), an open-source goal-driven productivity tool. Built with NestJS, Prisma, and PostgreSQL.

- **Live API:** https://api.goalslot.io
- **Live app:** https://app.goalslot.io
- **API docs (Swagger):** https://api.goalslot.io/api/docs
- **Frontend repo:** [goal-slot-web](https://github.com/ZeeshanAdilButt/goal-slot-web)

GoalSlot ties goals, schedule, time tracking, tasks, notes, journal, and reports into one place. This repo is the system of record for everything: it owns the database, the auth flow, the AI Coach layer, the integrations, and the public sharing surface.

## What it serves

| Module | What it owns |
|---|---|
| **Auth** | Email + OTP registration, JWT access + refresh, Google OAuth (in progress), Supabase SSO |
| **Goals** | CRUD, ordering, archive, categories, labels, linked tasks and time |
| **Schedule** | Weekly recurring time blocks linked to goals |
| **Time entries** | Live timer state, manual entries, aggregation across goals |
| **Tasks** | Daily lists with goal links and priority |
| **Notes** | Tiptap-compatible storage with parent/child hierarchy and drag-ordering |
| **Sharing** | Per-resource public link tokens and email invites via Resend |
| **Coach (AI)** | BYOK + shared-key narrative layer over OpenAI, Anthropic, and Gemini |
| **Integrations** | Notion OAuth + reference search + push (in progress, [#48](https://github.com/ZeeshanAdilButt/goal-slot-api/pull/48)) |
| **Whiteboards** | Excalidraw-backed canvases shareable like notes (in progress, [#51](https://github.com/ZeeshanAdilButt/goal-slot-api/pull/51)) |
| **Reports** | Aggregated daily, weekly, and monthly focus stats |
| **Billing** | Stripe checkout + webhooks for the PRO plan |
| **Email** | Resend-backed transactional templates |
| **Admin** | User management, feedback intake, release notes |

The full route surface is browsable on Swagger at [api.goalslot.io/api/docs](https://api.goalslot.io/api/docs) and locally at http://localhost:4000/api/docs once you have the server running.

## Why open source?

Most productivity tools either own your data or rent it back to you. GoalSlot is open source, self-hostable, and contributor-driven. The roadmap lives on the public issue board, not behind a paywall.

## New here? Start with these two files

1. **[SETUP.md](SETUP.md)** walks you from "I just found this repo on GitHub" to "I have the API running locally at localhost:4000 against a local Postgres". Budget 30 to 60 minutes the first time. The Postgres install is the only slow part, and the guide covers Docker, native, and Postgres.app paths.
2. **[CONTRIBUTING.md](CONTRIBUTING.md)** is the contribution flow. **Read it before you write any code.** The single hard rule is **claim-before-you-code**: pick an open issue, comment to claim it, wait for a maintainer to assign it to you, then open the PR. Skipping the claim step results in the PR being closed, even if the code is good, because we already promised the work to whoever is assigned.

Open issue boards:
- API: [goal-slot-api/issues](https://github.com/ZeeshanAdilButt/goal-slot-api/issues)
- Web: [goal-slot-web/issues](https://github.com/ZeeshanAdilButt/goal-slot-web/issues)

Filter on `good first issue` or `help wanted` for newcomer-friendly scopes. Cross-repo features (touching both web and API) are tracked with linked PRs that ship together.

One of the most interesting open scopes right now is the [`goalslot` CLI ([#27](https://github.com/ZeeshanAdilButt/goal-slot-api/issues/27))](https://github.com/ZeeshanAdilButt/goal-slot-api/issues/27), a terminal client that hits this API plus a local MCP bridge for coding agents like Claude Code.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | NestJS |
| ORM | Prisma 7 |
| Database | PostgreSQL (Supabase in production) |
| Language | TypeScript |
| Auth | passport-jwt, passport-google-oauth20 (in progress), Supabase SSO |
| Email | Resend |
| AI providers | OpenAI, Anthropic, Google Gemini (BYOK + shared) |
| Billing | Stripe |
| API docs | Swagger at `/api/docs` |
| Validation | class-validator + class-transformer |
| Rate limiting | @nestjs/throttler |
| Encryption | AES-256-GCM for stored BYOK keys |
| Package manager | **pnpm** (do not use npm or yarn; the lockfile is `pnpm-lock.yaml`) |

## Quick start

Full walkthrough with the three Postgres install options and troubleshooting is in [SETUP.md](SETUP.md). TL;DR:

```bash
git clone https://github.com/YOUR_USERNAME/goal-slot-api.git
cd goal-slot-api
pnpm install
cp .env.example .env
# fill in DATABASE_URL, DIRECT_URL, JWT_SECRET, JWT_EXPIRATION
pnpm prisma migrate dev
pnpm start:dev
```

API at http://localhost:4000, Swagger at http://localhost:4000/api/docs.

## Coach (BYOK)

Coach is a Socratic productivity layer using user-provided OpenAI, Anthropic, or Gemini keys (Bring Your Own Key). Every saved key is encrypted at rest with AES-256-GCM.

### Required env var

```
BYOK_ENCRYPTION_KEY=<base64 32-byte AES-256 key>
```

Generate one with:

```
openssl rand -base64 32
```

**Production must use a separate value stored as an env secret, never reused from dev.** Rotating this value invalidates every previously stored BYOK key (users have to re-enter theirs).

A shared-key fallback (Google Gemini Flash via `GOOGLE_AI_SHARED_API_KEY`) is also supported for users without their own key, capped per-user per-day via `SHARED_COACH_DAILY_LIMIT`.

### Rate limits

- 30 AI requests / 24h / user, enforced by per-user `ThrottlerGuard`
- 100,000 tokens / month / user (default), tracked in `EncryptedByokKey.tokensUsedThisMonth`, auto-resets every 30 days
- The narrative cache (existing message for a given `scopeKey`) is served without invoking the LLM or counting against either budget

Full route surface in [docs/coach-api.md](docs/coach-api.md).

## Integrations

### Google Calendar

Two-way Google Calendar sync. PR1 ships the inbound half: connect a Google account, pick calendars, and see their events on the schedule grid (read-only). Refresh tokens are encrypted at rest with the same AES-256-GCM `EncryptionService` as Coach BYOK keys.

#### Env vars

```
GOOGLE_OAUTH_CLIENT_ID=<from Google Cloud console>
GOOGLE_OAUTH_CLIENT_SECRET=<from Google Cloud console>
GOOGLE_OAUTH_REDIRECT_URI=https://api.goalslot.io/api/integrations/google/callback
```

All three are optional — when unset the feature is disabled and `GET /api/integrations/google/connect` returns `503`. For local dev set the redirect URI to `http://localhost:4000/api/integrations/google/callback` and add it to the OAuth client's authorized redirect URIs.

Scope requested: `https://www.googleapis.com/auth/calendar` (full, up front so the PR2 push half needs no second consent) plus `userinfo.email`.

#### Notes

- **Unverified app:** v1 ships before Google app verification, so users see a "Google hasn't verified this app" warning on the consent screen. The web connect dialog explains this.
- **One Google account per user**, enforced at the API — a second account with a different email is rejected.
- **Sync:** incremental via per-calendar `syncToken`; a 5-minute `@Cron` reconciles all active connections (first cron in the codebase, runs fine on the long-running VPS). A revoked grant (`invalid_grant`) marks the connection `stale` and is surfaced in Settings.

## Deployment

The production API runs on a self-hosted Windows VPS at api.goalslot.io. Auto-deploy is via GitHub Actions on every push to `main`. See [docs/deploy-windows-vps.md](docs/deploy-windows-vps.md) for the runbook.

Migrations apply automatically on deploy via `pnpm prisma migrate deploy`. Destructive migrations (column drops, type narrowing) need to be flagged in the PR body so the maintainer can plan the deploy window.

## Scripts

| Command | What it does |
|---|---|
| `pnpm start:dev` | Dev server with hot reload on port 4000 |
| `pnpm start` | Production server |
| `pnpm build` | Compile TypeScript |
| `pnpm lint` | ESLint |
| `pnpm prisma migrate dev` | Apply pending migrations to local DB |
| `pnpm prisma studio` | Browser-based DB explorer at http://localhost:5555 |

## Project layout

```
goal-slot-api/
├── src/
│   ├── modules/
│   │   ├── auth/           # JWT + OTP + Google OAuth + SSO
│   │   ├── users/
│   │   ├── goals/
│   │   ├── schedule/
│   │   ├── time/
│   │   ├── tasks/
│   │   ├── notes/
│   │   ├── sharing/        # Public links + email invites
│   │   ├── coach/          # BYOK encryption, narrative, journal, AI streaming
│   │   ├── notion-integration/   # In progress (#48)
│   │   ├── email/          # Resend templates
│   │   ├── billing/        # Stripe
│   │   └── admin/
│   ├── prisma/             # PrismaService
│   └── main.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── docs/
│   ├── coach-api.md
│   └── deploy-windows-vps.md
├── SETUP.md                # First-time setup walkthrough
├── CONTRIBUTING.md         # Contribution flow (READ BEFORE WRITING CODE)
└── README.md               # This file
```

## Questions

Open a discussion or comment on the relevant issue. For setup help specifically, see the troubleshooting section in [SETUP.md](SETUP.md) or open a new issue with label `setup-help`.
