# Contributing — Backend (`goal-slot-api`)

Thanks for taking the time to contribute. This guide covers everything
specific to the **`goal-slot-api`** service: how to set it up locally,
where the code lives, how to add features and migrations, and how to
get a backend change reviewed and merged.

If you're working on the web app, see `CONTRIBUTING_FE.md` instead in the goal-slot-web repo.
For project-wide policies (code of conduct, PR templates), the root
`CONTRIBUTING.md` is the source of truth — this file repeats the
parts you actually need while doing backend work.

If anything here is unclear, open a discussion or issue — fixing a
confusing onboarding step is itself a great first contribution.

---

## Table of contents

1. [Code of conduct](#code-of-conduct)
2. [Repository layout](#repository-layout)
3. [Ways to contribute](#ways-to-contribute)
4. [Development setup](#development-setup)
5. [Picking an issue](#picking-an-issue)
6. [Branching and commit conventions](#branching-and-commit-conventions)
7. [Code style](#code-style)
8. [Testing](#testing)
9. [Opening a pull request](#opening-a-pull-request)
10. [Reporting bugs](#reporting-bugs)
11. [Proposing a feature](#proposing-a-feature)
12. [Getting help](#getting-help)

---

## Code of conduct

Be kind, be patient, and assume good faith. Goal Slot follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Harassment, personal attacks, or discriminatory language are not welcome
in issues, pull requests, or any community channel. Report violations
to the maintainers privately.

---

## Repository layout

The backend is a **NestJS 10** application using **Prisma 7** against
**PostgreSQL**, written in TypeScript. Every feature lives in its
own Nest module under `src/modules/`, and every module follows the
same `controller / service / dto/` shape so once you've read one,
you've read them all.

```
goal-slot-api/
├── .env.example                Template for required environment variables
├── .dockerignore               Files excluded from the Docker build context
├── .gitignore
├── Dockerfile                  Production container build
├── nest-cli.json               Nest CLI config (entry file, asset paths)
├── package.json                Scripts + dependencies (pnpm-managed)
├── pnpm-lock.yaml              Lockfile — do not hand-edit
├── prisma.config.ts            Prisma 7 config (schema path, seed command, DATABASE_URL loader)
├── tsconfig.json               TypeScript compiler options
├── vercel.json                 Vercel deployment settings (routes, build)
│
├── .github/
│   └── workflows/              CI pipelines (lint, test, build, deploy)
│
├── prisma/
│   ├── schema.prisma           Source of truth for the database model
│   ├── migrations/             Timestamped SQL migrations — one folder per migration
│   │   └── <timestamp>_<name>/migration.sql
│   ├── create-prisma-client.ts Factory that builds a PrismaClient from DATABASE_URL
│   ├── seed.ts                 Seeds an admin + sample users (run via `pnpm seed`)
│   ├── generate-data.ts        Bulk fixture generator for local testing
│   └── update-user-id.ts       One-off utility for fixing user-id rows
│
└── src/
    ├── main.ts                 Nest bootstrap: CORS, validation, Swagger, listen()
    ├── app.module.ts           Root module — imports every feature module
    │
    ├── prisma/                 Prisma DB-access wrapper
    │   ├── prisma.module.ts
    │   └── prisma.service.ts   Extends PrismaClient; injected wherever you need DB
    │
    ├── supabase/               Supabase admin client (used for SSO token verification)
    │   ├── supabase.module.ts
    │   └── supabase.service.ts
    │
    ├── shared/                 Cross-cutting concerns shared by all modules
    │   ├── configuration/
    │   │   └── env.validation.ts   Joi schema — rejects boot if env is incomplete
    │   ├── filters/
    │   │   └── posthog-exception.filter.ts   Global error reporter
    │   ├── modules/
    │   │   └── posthog.module.ts             PostHog DI wiring
    │   └── services/
    │       └── posthog.service.ts            Server-side analytics client
    │
    └── modules/                One folder per feature; each is a Nest module
        ├── auth/               Email/password + OTP + SSO + JWT issuance
        │   ├── auth.module.ts
        │   ├── auth.controller.ts
        │   ├── auth.service.ts
        │   ├── plan-limits.ts          Per-plan quota constants
        │   ├── decorators/             @Roles(), @Subscription(), …
        │   ├── dto/                    Request/response DTOs (class-validator)
        │   ├── guards/                 JWT, roles, subscription gates
        │   └── strategies/             Passport JWT strategy
        │
        ├── users/              Profile + admin user management
        │   └── dto/
        ├── goals/              Long-term goal CRUD + stats
        │   └── dto/
        ├── tasks/              Task board, status, reordering, notes
        │   └── dto/
        ├── time-entries/       Time tracking entries (manual + timer)
        │   └── dto/
        ├── schedule/           Recurring weekly schedule blocks
        │   └── dto/
        ├── reports/            Detailed / summary / export endpoints
        │   └── dto/
        ├── categories/         Goal categories
        │   └── dto/
        ├── labels/             Goal labels
        │   └── dto/
        ├── notes/              Hierarchical notes (Tiptap content)
        │   └── dto/
        ├── sharing/            Share-by-email + public links + accept/revoke
        │   └── dto/
        ├── feedback/           In-app feedback collection + admin replies
        │   └── dto/
        ├── notifications/      In-app notification feed
        ├── release-notes/      Changelog entries surfaced in the UI
        │   └── dto/
        ├── email/              Resend integration (welcome, share invites, OTP)
        ├── stripe/             Checkout, portal, webhooks, subscription status
        └── health/             Liveness / readiness probes
```

### Anatomy of a feature module

Every module under `src/modules/<feature>/` follows the same shape.
Using `goals/` as the canonical example:

```
goals/
├── goals.module.ts          @Module({ controllers, providers, imports, exports })
├── goals.controller.ts      HTTP route handlers + Swagger decorators
├── goals.service.ts         Business logic + Prisma queries
└── dto/                     Input/output shapes validated by class-validator
    ├── create-goal.dto.ts
    ├── update-goal.dto.ts
    └── …
```

When you add a new feature, follow the same layout. When you edit an
existing one, keep responsibilities where they already live —
controllers stay thin (validation, auth, response shape), services
own data access and business rules. The `auth/` module is the only
one with extra subfolders (`decorators/`, `guards/`, `strategies/`)
because Passport + JWT plumbing doesn't fit cleanly into the
controller/service split.

### Wiring rules

| When you…                              | You must also…                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Add a new module                       | Register it in `src/app.module.ts` — DI only sees modules transitively imported by the root.    |
| Add a new env var                      | Add it to `src/shared/configuration/env.validation.ts` **and** to `.env.example`.               |
| Change the DB schema                   | Edit `prisma/schema.prisma`, run `pnpm prisma:migrate`, commit both the schema and the new `prisma/migrations/<timestamp>_*/` folder. Never hand-edit a committed migration. |
| Call an external API (Stripe, Resend…) | Wrap it in a service under `src/modules/<feature>/` or `src/shared/services/`. Don't import the SDK directly inside a controller. |
| Change CORS, validation, body limits   | Edit `src/main.ts` — these globals don't belong in individual modules.                          |

### Key files at a glance

| File / folder                              | Why it matters                                          |
| ------------------------------------------ | ------------------------------------------------------- |
| `src/main.ts`                              | Bootstrap: CORS, validation, Swagger, port binding     |
| `src/app.module.ts`                        | Top-level Nest module — wires every feature module     |
| `src/shared/configuration/env.validation.ts` | Joi schema; missing keys crash boot                  |
| `prisma/schema.prisma`                     | Source of truth for the database model                 |
| `prisma/migrations/`                       | Migration history — never edit committed entries       |
| `prisma/seed.ts`                           | Local-dev admin user + fixtures                        |
| `prisma.config.ts`                         | Prisma 7 config; loads `.env` and defines `db seed`    |

---

## Ways to contribute

You don't have to write code to help. Useful contributions include:

- **Bug reports** with clear reproduction steps.
- **Documentation fixes** — typos, missing steps in this guide,
  unclear comments, outdated examples.
- **Triage** — reproducing reported bugs, labelling issues, asking
  reporters for missing info.
- **Feature proposals** — open a discussion first; we'd rather agree on
  the shape of a change before you write it.
- **Code** — bug fixes, new features, refactors, tests, performance
  work. Small, focused PRs are easier to review than large ones.

---

## Development setup

Follow these steps end-to-end on a fresh checkout before opening
your first PR. If any step doesn't work on your machine, that's
almost certainly a bug in this guide and a perfect first
contribution — open an issue or PR with the fix.

`goal-slot-api` is a NestJS service that listens on port **4000** by
default and exposes its routes under `/api/*`. Swagger documentation
is mounted at `/api/docs`. To exercise endpoints from a browser
you'll also want to run `goal-slot-web` — see `CONTRIBUTING_FE.md` —
but everything in this section is self-contained: you can develop,
test, and hit the API with `curl` or the Swagger UI without ever
starting the frontend.

### Step 1 — Prerequisites (install once)

Minimum versions: **Node.js ≥ 20**, **pnpm ≥ 9**,
**PostgreSQL ≥ 14**.

**Node.js.** Check your current version:

```bash
node --version
```

If missing or below 20, install via [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# restart your shell, then:
nvm install 20
nvm use 20
```

**pnpm.** Both apps use pnpm (the lockfiles are `pnpm-lock.yaml`):

```bash
npm install -g pnpm
pnpm --version
```

**PostgreSQL (native install on Ubuntu/Debian):**

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
psql --version
```

The `postgresql-contrib` package adds optional extensions
(`pgcrypto`, `uuid-ossp`, `pg_trgm`, `pg_stat_statements`, …) that
the schema or future migrations may need. Installing it up front
avoids re-running apt later.

### Step 2 — Create the database and a dedicated role

Never use the `postgres` superuser for app development. Create a
scoped role and database:

```bash
sudo -u postgres psql <<'SQL'
CREATE USER goalslot WITH PASSWORD 'goalslot';
CREATE DATABASE goalslot OWNER goalslot;
GRANT ALL PRIVILEGES ON DATABASE goalslot TO goalslot;
ALTER USER goalslot CREATEDB;
SQL
```

Verify the connection works as the app would:

```bash
PGPASSWORD=goalslot psql -h localhost -U goalslot -d goalslot -c '\conninfo'
```

You should see `You are connected to database "goalslot" as user "goalslot"`.

If you instead get *"Peer authentication failed"*, edit
`/etc/postgresql/<version>/main/pg_hba.conf`, change the line
`local all all peer` to `local all all md5` (or `scram-sha-256`),
then `sudo systemctl restart postgresql` and re-run the check.

### Step 3 — Backend (`goal-slot-api`)

From the repo root:

```bash
cd goal-slot-api
pnpm install
```

**Configure environment.** Copy the example and edit it:

```bash
cp .env.example .env
```

Open `.env` and set the following keys. Joi validation in
`src/shared/configuration/env.validation.ts` rejects the app on boot
if any required key is missing or malformed, so don't leave them
blank. Stub values are fine for everything except `DATABASE_URL` and
`JWT_SECRET`:

```dotenv
NODE_ENV=development
PORT=4000
CORS_ORIGIN=http://localhost:3010

JWT_SECRET=any-non-empty-secret-for-local-dev
JWT_EXPIRATION=7d

DATABASE_URL=postgresql://goalslot:goalslot@localhost:5432/goalslot?schema=public
DIRECT_URL=postgresql://goalslot:goalslot@localhost:5432/goalslot?schema=public

SUPABASE_URL=http://localhost
SUPABASE_SERVICE_ROLE_KEY=dev-service-role-key

RESEND_API_KEY=re_dev_stub_key
APP_URL=http://localhost:3010

STRIPE_SECRET_KEY=sk_test_mock
STRIPE_PRICE_ID=price_mock
STRIPE_WEBHOOK_SECRET=whsec_mock

POSTHOG_API_KEY=phc_dev_stub
POSTHOG_HOST=https://us.i.posthog.com
```

The stubbed Supabase/Stripe/Resend/PostHog values let the app boot;
the features that actually call those services (SSO login, payments,
outbound email, analytics) won't work until you replace them with
real keys. For most contribution work, leave them stubbed.

**Generate the Prisma client and run migrations:**

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

`prisma:generate` writes a typed client into `node_modules/@prisma/client`.
`prisma:migrate` applies every SQL migration under `prisma/migrations/`
to your `goalslot` database. On a fresh DB it prints
*"Database is now in sync with your schema."*

**Seed the admin user** so you can log in:

```bash
pnpm seed
```

This creates `admin@devweekends.com` / `SuperAdmin123!` as a
super-admin. If the seed fails with *"Missing DATABASE_URL"*, run it
as `pnpm exec prisma db seed` instead — that path loads `.env`
through `prisma.config.ts`.

**Start the dev server:**

```bash
pnpm start:dev
```

You should see:

```
⚡ Time Master API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 Server running on: http://localhost:4000
📚 API Docs: http://localhost:4000/api/docs
🔑 Environment: development
```

Smoke-test the API directly with `curl` or by opening Swagger:

```bash
curl http://localhost:4000/api/health
# or open http://localhost:4000/api/docs in a browser
```

Leave this terminal running.

### Day-to-day commands

From **`goal-slot-api/`**:

| Command                 | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm start:dev`        | Nest server with file-watch reload                          |
| `pnpm prisma:studio`    | Browser GUI for your local DB                               |
| `pnpm prisma:migrate`   | Apply pending migrations (and create new ones interactively)|
| `pnpm prisma:generate`  | Regenerate the typed Prisma client after a schema edit      |
| `pnpm seed`             | Re-run the seed script (idempotent — uses `upsert`)         |
| `pnpm lint`             | ESLint with `--fix`                                         |
| `pnpm test`             | Run unit tests                                              |
| `pnpm test:watch`       | Jest in watch mode                                          |
| `pnpm test:cov`         | Unit tests with coverage report                             |
| `pnpm test:e2e`         | End-to-end test suite                                       |
| `pnpm build`            | Compile the production bundle (catches type errors)         |

### Troubleshooting

**Backend exits immediately with `"<key>" is required`.** Your `.env`
is missing that key. Check it against the list in step 3.

**`P1001: Can't reach database server at localhost:5432`.** Postgres
isn't running. `sudo systemctl start postgresql` then retry.

**`P1010: User goalslot was denied access on the database`.** Either
the password in `DATABASE_URL` is wrong, or `pg_hba.conf` is using
peer authentication. See the note at the end of step 2.

**Browser request from a frontend hits a CORS error.** The backend's
`CORS_ORIGIN` doesn't include the calling origin. Add the frontend's
URL (comma-separated for multiple) to `CORS_ORIGIN` in `.env` and
restart `pnpm start:dev`.

**`pnpm seed` fails with "Missing DATABASE_URL".** The seed script
runs through ts-node, which doesn't auto-load `.env`. Use
`pnpm exec prisma db seed` instead — that goes through
`prisma.config.ts`, which calls `import "dotenv/config"`.

**`prisma migrate dev` asks to reset the database.** Safe to say yes
locally — it drops and recreates your `goalslot` DB. Never do this
on a shared or staging DB.

---

## Picking an issue

1. Browse open issues at
   [`/issues`](../../issues).
2. Look for labels that fit your level:
   - **`good first issue`** — small, well-scoped, low context required.
   - **`help wanted`** — the team has decided it should be done but
     isn't actively working on it.
   - **`bug`** / **`enhancement`** — broader buckets, may need a design
     discussion first.
3. Drop a comment saying you'd like to take it. Wait for a maintainer
   (or the original reporter) to confirm before starting — this avoids
   two people doing the same work.
4. If nothing on the issue tracker matches what you want to work on,
   open a new issue describing the problem or proposal before writing
   code. PRs that arrive without prior discussion are still welcome,
   but they may be sent back if the direction doesn't fit the
   roadmap.

---

## Branching and commit conventions

### Branch from `main`

```bash
git checkout main
git pull
git checkout -b <type>/<short-description>
```

Use one of these prefixes so the branch's intent is obvious:

| Prefix      | Use for                                   |
| ----------- | ----------------------------------------- |
| `feat/`     | New user-visible feature                  |
| `fix/`      | Bug fix                                   |
| `refactor/` | Code change with no behaviour change      |
| `docs/`     | Documentation only                        |
| `test/`     | Tests only                                |
| `chore/`    | Tooling, dependencies, CI                 |

Examples: `feat/weekly-report-export`, `fix/login-401-on-refresh`,
`docs/setup-postgres-ubuntu-24`.

### Commit messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/)
style. The first line is:

```
<type>(<optional scope>): <short, imperative summary>
```

- `type` is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
  `perf`, `style`, `build`, `ci`.
- `scope` is the area of the code, e.g. `auth`, `goals`, `web`, `api`.
- Summary is **imperative mood**, lowercase, no trailing period.
  Write "add weekly export" not "added weekly export" or "Adds…".

Examples:

```
feat(reports): add CSV export to weekly summary
fix(auth): clear refresh token when password is rotated
docs(setup): document pg_hba peer-auth gotcha on Ubuntu 24
chore(deps): bump prisma from 7.4.1 to 7.5.0
```

Keep one logical change per commit. If a reviewer asks you to revise,
**amend or squash** rather than tacking on "address review" commits —
the merged history should read as a clean story.

---

## Code style

Style is enforced by linters and formatters — don't argue with the
tools, run them.

### Linters & formatters

```bash
pnpm lint           # eslint --fix
pnpm test           # unit tests, must pass before pushing
pnpm build          # full TypeScript compile — run this before opening a PR
```

### TypeScript

- **Strict mode is on.** No `any` unless commented with a
  justification.
- Prefer **`unknown` + narrowing** over `any` for values you can't
  type at the boundary.
- Use the types exported from `@prisma/client` (`User`, `Goal`, …)
  rather than redeclaring shapes by hand.

### NestJS conventions

- One feature module per folder under `src/modules/`, with the
  standard `*.module.ts`, `*.controller.ts`, `*.service.ts` triad.
- DTOs go under the module's `dto/` folder and use
  **`class-validator`** decorators. The global `ValidationPipe`
  in `main.ts` rejects malformed requests automatically.
- Controllers stay thin: route definition, auth guards, request
  validation, response shape. Business logic lives in the service.
- Use **dependency injection** for everything you'd otherwise
  import as a singleton — including external SDKs (Stripe, Resend,
  Supabase). Wrap them in a service so they can be mocked in tests.
- Annotate every endpoint with Swagger decorators (`@ApiTags`,
  `@ApiOperation`, `@ApiResponse`). The Swagger UI at `/api/docs`
  is the contract the frontend and external consumers read.

### Prisma & migrations

- Never write raw SQL in a service unless the typed client truly
  can't express the query. Prefer `prisma.$queryRawTyped` over
  unsafe `$queryRaw` when raw is genuinely needed.
- Every schema change ships with a migration:

  ```bash
  pnpm prisma:migrate
  ```

  Commit both the edit to `prisma/schema.prisma` **and** the new
  folder generated under `prisma/migrations/`.
- Never hand-edit a committed migration. If a migration is wrong,
  create a new one that corrects it. The migration history must
  match what's already been applied to staging/prod.
- Use `@default(uuid())` for IDs, `DateTime @default(now())` for
  timestamps, and `@@index([…])` for any column you filter on.

### Auth, roles, and plan gating

- New endpoints default to authenticated. Use `@Public()` (declared
  in `src/modules/auth/decorators/`) only when you intentionally
  want unauthenticated access (login, public share links, health).
- Role-restricted endpoints use `@Roles(UserRole.ADMIN)` +
  `RolesGuard`. Plan-gated features use `@Subscription(...)` +
  `SubscriptionGuard`.

### Cross-cutting

- No commented-out code in the diff. If you want to keep it for
  reference, save it elsewhere; git will remember.
- Comments explain *why*, not *what*. Well-named identifiers cover
  the "what".
- No personal credentials or `.env` values in commits. The
  `.gitignore` already excludes `.env`; double-check `git status`
  before committing.

---

## Testing

- **Bug fix** → add a regression test that fails on `main` and passes
  on your branch.
- **New feature** → add at least happy-path tests; edge cases earn
  extra points.
- **Refactor** → existing tests should still pass; add tests if the
  refactor exposed previously-untested behaviour.

Run the test suite before pushing:

```bash
cd goal-slot-api
pnpm test           # unit tests (Jest)
pnpm test:e2e       # end-to-end suite — slower; run before opening the PR
pnpm test:cov       # optional: coverage report
```

Test files live next to the code they exercise as `*.spec.ts`
(unit) or under the `test/` directory (e2e). Use the NestJS
testing utilities (`Test.createTestingModule`) to wire up a real
DI container with mocked providers — don't `new` services
directly in tests.

If a flaky test blocks you and you're sure it's not related to your
change, mention it in the PR description rather than silently
disabling it.

---

## Opening a pull request

1. Push your branch and open a PR against `main`.
2. Use this template in the PR description:

   ```markdown
   ## Summary
   <one-paragraph description of what changed and why>

   ## Related issue
   Closes #<issue-number>

   ## Type of change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Refactor
   - [ ] Docs
   - [ ] Other: …

   ## How I tested this
   <commands run, manual steps, screenshots if UI>

   ## Checklist
   - [ ] Linked the issue this PR resolves
   - [ ] Added/updated tests
   - [ ] `pnpm lint` and `pnpm test` pass locally
   - [ ] Updated docs (READMEs, this CONTRIBUTING guide, code
         comments) where needed
   - [ ] No `.env`, secrets, or generated files committed
   ```

3. Keep PRs small. If your change touches more than ~400 lines outside
   of generated files (lockfiles, migrations), consider splitting.
4. Mark the PR as **draft** while you're still iterating. Mark it
   **ready for review** when CI is green and you'd be happy for it to
   merge as-is.
5. Be responsive to review comments. Stuck on one? Say so — silence
   is harder to help with than "I don't know how to fix this".

The maintainers aim to give a first response within a week. Pings
after that are welcome.

---

## Reporting bugs

A good bug report includes:

- **What you did** — exact commands, URLs, or UI steps.
- **What you expected** — the behaviour you thought you'd see.
- **What actually happened** — error messages copy-pasted as text
  (not screenshots of terminals), stack traces, screenshots for UI.
- **Environment** — OS, Node version (`node --version`), pnpm
  version, browser if it's a UI bug.
- **Reproduction** — minimum steps to reproduce, ideally on a fresh
  clone with seeded data.

If you can include the failing request/response pair (browser
DevTools → Network → copy as cURL), that often cuts triage time in
half.

---

## Proposing a feature

Before you build something non-trivial, open a discussion or an
issue tagged **`enhancement`** describing:

- The problem the feature solves (user-facing, not implementation).
- Who it affects and how often.
- A rough sketch of the proposed UX or API.
- Any alternatives you considered.

The team will reply with feedback or a green light. This step
protects your time — there's nothing worse than landing a 500-line
PR only to learn the direction doesn't match the roadmap.

---

## Getting help

- **Setup not working?** → re-read the *Development setup* and
  *Troubleshooting* sections above, then open a GitHub Discussion
  with the exact command you ran and the full error output.
- **Stuck on an issue you're working on?** → leave a comment on the
  issue; tag the maintainer who triaged it.
- **Security report** → do **not** open a public issue. Email the
  maintainers (see repo profile) with details and reproduction.

Welcome aboard, and thanks again for helping make Goal Slot better.
