# GoalSlot API: First-time Setup

A complete walkthrough from "I just found this repo on GitHub" to
"I have the API running on my laptop with a working local database".
Setup is more involved than the web repo because the API talks to
Postgres. Budget 30 to 60 minutes the first time.

If you get stuck at any step, open an issue with the label
`setup-help` and paste the exact error message you saw. Do not DM.

---

## What you will end up with

By the end of this guide you will have:

- A fork of `goal-slot-api` on your own GitHub account.
- The code cloned to your laptop.
- A local Postgres database with the schema applied.
- All dependencies installed.
- A working `.env` file.
- The API running at `http://localhost:4000` with Swagger docs at
  `http://localhost:4000/api/docs`.

If you only need to verify a backend behavior without making changes,
you can also point the web repo at `https://api.goalslot.io` (the
staging API) instead of running the API locally. Set this up only when
your contribution touches backend code.

---

## Prerequisites

Install these BEFORE you clone the repo.

| Tool | Minimum version | How to check | How to install |
|---|---|---|---|
| Node.js | 20.x or 22.x | `node --version` | https://nodejs.org/ (LTS download) |
| pnpm | 9.x or 10.x | `pnpm --version` | `npm install -g pnpm` after Node |
| Git | Any recent | `git --version` | https://git-scm.com/ |
| Postgres | 14.x or newer | `psql --version` | See "Installing Postgres" below |
| A GitHub account | n/a | github.com sign-in | https://github.com/signup |

### Installing Postgres

You have three options. Pick the one you are most comfortable with:

**Option A (recommended for most): Docker.** If you already use Docker
for other projects, this is the cleanest. Once Docker is installed,
you can start Postgres with one command:

```bash
docker run --name goalslot-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=goalslot \
  -p 5432:5432 \
  -d postgres:16
```

To stop it later: `docker stop goalslot-postgres`. To start it again:
`docker start goalslot-postgres`. The data persists across stops.

**Option B: Postgres.app (macOS).** Download from
https://postgresapp.com/ and follow their installer. The app gives you
a menu-bar Postgres that's running whenever the app is open.

**Option C: Native install.** On macOS use Homebrew
(`brew install postgresql@16`). On Linux use your package manager
(`sudo apt install postgresql-16`). On Windows use the installer from
https://www.postgresql.org/download/windows/.

Whichever you pick, verify Postgres is running by trying:

```bash
psql -h localhost -U postgres -c "SELECT 1;"
```

You should see `1` printed. If it asks for a password and `postgres`
does not work, look up the password your installer set or reset it.

---

## Step 1: Fork the repo

1. Open https://github.com/ZeeshanAdilButt/goal-slot-api in your
   browser while signed in to GitHub.
2. Click the **Fork** button in the top-right.
3. Leave the defaults and click **Create fork**.
4. GitHub redirects you to your fork at
   `https://github.com/YOUR_USERNAME/goal-slot-api`.

---

## Step 2: Clone your fork

In a terminal, navigate to wherever you keep code projects, then:

```bash
git clone https://github.com/YOUR_USERNAME/goal-slot-api.git
cd goal-slot-api
```

---

## Step 3: Add the upstream remote

```bash
git remote add upstream https://github.com/ZeeshanAdilButt/goal-slot-api.git
git remote -v
```

You should see `origin` (your fork) and `upstream` (the main repo).

---

## Step 4: Install dependencies

```bash
pnpm install
```

First install takes 2 to 5 minutes. You may see warnings about peer
deps and ignored build scripts; these are normal.

---

## Step 5: Create the local database

If you used Docker (Option A above), the database `goalslot` is
already created. Skip to Step 6.

If you installed Postgres natively or via Postgres.app, create the
database manually:

```bash
psql -h localhost -U postgres
```

Then inside the `psql` prompt:

```sql
CREATE DATABASE goalslot;
\q
```

---

## Step 6: Set up environment variables

1. Copy the example file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` in your editor.
3. Replace the placeholder values described below. Most of these have
   sensible defaults for local dev; only `DATABASE_URL`, `DIRECT_URL`,
   `JWT_SECRET`, and `JWT_EXPIRATION` are strictly required.

### The minimum required variables

```env
PORT=4000
CORS_ORIGIN=http://localhost:3010
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/goalslot?schema=public
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/goalslot?schema=public
JWT_SECRET=replace-me-with-a-random-string-at-least-32-chars
JWT_EXPIRATION=7d
APP_URL=http://localhost:4000
```

The Postgres URL format is
`postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE`. If you used the
Docker command above, the values shown work as-is. If you used a
different password or username during install, swap them in.

`JWT_SECRET` can be any random string at least 32 characters long. For
local dev a placeholder like `dev-secret-not-for-production-use` is
fine. For PRs that ever touch production, you do NOT set the
production value here; the server reads it from the deploy
environment.

### Variables that can stay as placeholders

These are not needed unless your PR touches their respective
features:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: SSO. Leave as-is.
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`:
  Billing. Leave as-is.
- `POSTHOG_API_KEY`, `POSTHOG_HOST`: Analytics. Leave as-is.
- `ONBOARDING_EMAIL`, `NOTIFICATION_EMAIL`: Email sender addresses.
  Leave as-is unless your PR touches the email module.
- `BYOK_ENCRYPTION_KEY`: Coach feature. Generate with
  `openssl rand -base64 32` if your PR touches the Coach module.
- `GOOGLE_AI_SHARED_API_KEY`, `SHARED_COACH_DAILY_LIMIT`: Coach
  fallback. Optional, get a free key from
  https://aistudio.google.com/apikey if you need it.

If you ever need real values for any of these, ping a maintainer on
the relevant issue and we will get them to you privately.

---

## Step 7: Apply the database schema

This creates all the tables in your local Postgres:

```bash
pnpm prisma migrate dev
```

Prisma will read every migration in `prisma/migrations/` and apply
them in order. The first run takes 30 to 60 seconds and creates about
40 tables.

After it finishes, you can verify the schema with:

```bash
pnpm prisma studio
```

This opens a browser-based DB browser at `http://localhost:5555`. You
should see the table list in the sidebar (User, Goal, Task, TimeEntry,
etc.). Close the browser tab and `Ctrl+C` to exit Studio.

---

## Step 8: Start the dev server

```bash
pnpm start:dev
```

After 10 to 30 seconds you should see:

```
[Nest] Starting Nest application...
[Nest] Nest application successfully started
```

Verify it works:

- Open http://localhost:4000/api/docs in your browser. You should see
  Swagger with every endpoint listed.
- Hit a health endpoint from the terminal:
  ```bash
  curl http://localhost:4000/api/health
  ```
  You should get back JSON with `{"status":"ok",...}`.

To stop the dev server, `Ctrl+C` in the terminal.

---

## Step 9: Make sure the toolchain is healthy

Before writing any code, verify the build pipeline:

```bash
pnpm tsc --noEmit
pnpm lint
```

Both should complete with no errors. If you see TypeScript or lint
errors before changing anything, open a setup-help issue with the
output.

---

## Common errors and how to fix them

### `pnpm: command not found`

Run `npm install -g pnpm` once.

### Prisma error: `Can't reach database server`

Postgres is not running. If you used Docker:
`docker start goalslot-postgres`. If you used a native install, start
the Postgres service (Postgres.app, `brew services start postgresql@16`,
or `sudo systemctl start postgresql`).

### Prisma error: `database "goalslot" does not exist`

You skipped the "create the database" step. See Step 5 above.

### Prisma error: `password authentication failed`

The `DATABASE_URL` password does not match what your Postgres install
expects. Either reset the postgres user's password to match the URL,
or update the URL to match your actual password.

### `ERR_PNPM_OUTDATED_LOCKFILE`

You ran `npm install` or `yarn install` by mistake. Reset:

```bash
rm -rf node_modules package-lock.json yarn.lock
pnpm install
```

### Port 4000 is already in use

Either close whatever is using it, or set `PORT=4001` in `.env`.
Remember to also update the web repo's `NEXT_PUBLIC_API_URL` to match.

### My CORS errors

You started the API on a port other than 4000 OR you started the web
repo on a port other than 3010. Update `CORS_ORIGIN` in the API's
`.env` to the actual URL the frontend is running on.

---

## Pulling new migrations from upstream later

When you `git pull upstream main` and see new files in
`prisma/migrations/`, run:

```bash
pnpm prisma migrate dev
```

This applies the new migrations to your local DB. Skip this step and
the API will crash on startup with a `migration is required` error.

---

## Next steps

You are set up. Now read [CONTRIBUTING.md](CONTRIBUTING.md) to learn
the **claim-before-you-code** flow before opening a PR.

Once you have an issue assigned to you, the daily loop is:

1. Pull the latest from upstream:
   ```bash
   git checkout main
   git pull upstream main
   git push origin main
   pnpm prisma migrate dev   # apply any new migrations
   pnpm install              # install any new deps
   ```
2. Create a feature branch:
   ```bash
   git checkout -b feature/short-description
   ```
3. Write code, commit often, run `pnpm tsc --noEmit` and `pnpm lint`
   before each commit.
4. Push:
   ```bash
   git push -u origin feature/short-description
   ```
5. Open a PR from your fork to `ZeeshanAdilButt/goal-slot-api` main,
   with the issue link in the description.

Welcome to the project.
