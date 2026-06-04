# Contributing to GoalSlot API

Thanks for wanting to help. The single most important rule below is the
**claim-before-you-code** flow. Read it before you do anything else.

These guidelines are the same across both `goal-slot-web` and
`goal-slot-api`. Maintainers review every PR, issue, and comment on
both repositories against this document, so understanding it once
covers your contribution flow everywhere.

**Brand new to open source or to this codebase?** Start with
[SETUP.md](SETUP.md). It walks through forking, cloning, installing
Postgres, configuring environment variables, and running the API for
the first time. Once the API is running locally, come back here to
learn the contribution flow.

---

## Claim-before-you-code (the only rule we will reject PRs over)

We have multiple contributors and a small reviewer pool. To prevent two
people from spending days on the same feature only to have one PR get
discarded, every contribution must follow this flow:

1. **Pick an open issue.** Browse [open issues on the API repo](https://github.com/ZeeshanAdilButt/goal-slot-api/issues)
   and find one that is not already assigned to someone else. Check the
   right-hand "Assignees" panel and read the comments before claiming.

2. **Comment your claim on the issue.** Post a single comment like
   `Can I work on this?` or `I want to take this`. Wait for a maintainer
   to reply with an explicit acknowledgement (typically `Thanks @you,
   this one is yours`) and to assign the issue to your GitHub account.

3. **Do NOT start writing code until the issue is assigned to you.** If
   the assignee field on the issue is not your account, you do not have
   approval to work on it. PRs that implement an issue assigned to
   somebody else will be closed, even if the code is good, because we
   already promised the work to the assigned contributor.

4. **If the issue has been assigned to someone else but they have not
   opened a PR in a week and have not commented**, you may post a polite
   comment asking if they would like to pass it on. Wait for the
   maintainer's call before starting. Do not begin work in parallel.

5. **For ideas that do not have an issue yet**, open a new issue first
   describing what you want to build. Wait for a maintainer to label it
   and assign it to you. Same flow as above. Do not open a PR without
   a maintainer-approved issue behind it.

If you skip this flow, we will close the PR with a pointer back to this
section. Sorry to be strict. We have had situations where two
contributors did the same work and one of them lost a weekend.

---

## What "assigned to you" looks like

You can verify a maintainer has assigned the issue to you in two ways:

- The issue's right-hand "Assignees" panel shows your GitHub avatar.
- A maintainer comment says something like `this one is yours` or
  `you are good to go`.

If neither is true, you are not assigned.

---

## Before opening a PR

- Run `pnpm install` and `pnpm start:dev` and verify the endpoints work
  via Swagger (`http://localhost:4000/api/docs`) or `curl`.
- Run `pnpm tsc --noEmit` and `pnpm lint` and fix everything they
  complain about. CI will run these and a red CI delays review.
- If your change touches the Prisma schema, run `pnpm prisma migrate dev`
  locally and verify the migration applies cleanly. Hand-author the
  SQL when production needs to apply it (consistent with how the team
  ships migrations against the live database).
- If your PR is more than ~400 lines of diff, split it into 2 or 3
  smaller PRs that can be reviewed and landed independently. Long PRs
  sit in review for a long time.

## When opening a PR

**Every PR must reference an open, assigned issue.** This is the second
hard rule after claim-before-you-code, and PRs without an issue link
will be closed with a request to open one. Random PRs that arrive
without a tracked issue behind them break our ability to plan releases,
to coordinate contributors, and to make sure we are not duplicating
work that someone else has already claimed.

- Reference the assigned issue at the top of the description:
  `Related to #46` or `Closes #46`. The "Closes" form auto-closes the
  issue when the PR merges, so only use it on the PR that actually
  finishes the feature.
- If your work is part of a multi-PR plan (PR 1 of 3, PR 2 of 3, etc.),
  use `Related to #N (PR M of K)` on intermediate PRs and `Closes #N`
  only on the final PR.
- If there is no issue for what you want to do, **open one first**.
  Describe the scope, wait for a maintainer to label it and assign it
  to you, then open the PR. Do not skip the issue step. We will close
  the PR otherwise.
- If the issue is assigned to a different contributor, you do not have
  authority to open a PR for it. Coordinate with the assignee in the
  issue comments first. They have to agree in writing (in the issue) to
  hand the work off, and a maintainer reassigns before you start. See
  the claim-before-you-code section.
- If your issue lives on the other repo
  (`ZeeshanAdilButt/goal-slot-web`), reference it with the cross-repo
  form `ZeeshanAdilButt/goal-slot-web#190`.

Other PR description requirements:

- Describe what changed in a short summary, then list the files you
  touched and why.
- For features with user-visible behavior, include a Loom (2 to 4 min
  is plenty). For pure API work, a short list of curl commands or
  Swagger screenshots that verify the endpoints is enough.
- If your PR is one piece of a multi-PR feature, name which piece and
  which other PR it pairs with. For example: `PR 1 of 3, paired with
  goal-slot-web#217`.

## Pair PRs across repos

A feature that touches both `goal-slot-web` and `goal-slot-api` needs
both halves to ship together. Merging only the API half ships dead
endpoints; merging only the web half ships UI that 404s. If your
feature touches both repos:

- Open the PR on each repo at roughly the same time.
- Link them to each other in both descriptions.
- A PR with a missing counterpart will be **held, not closed**, until
  the other half exists. The code is fine, it just cannot ship alone.
- If you nudge a maintainer asking why a paired PR has not merged, we
  will tell you which half we are waiting on. If you can also take that
  other half, claim its issue first (the rule above). If you cannot,
  let us know and we will flag a different contributor to pair with you.

This rule is per cross-repo feature. It does not block a single
contributor's intermediate PRs within a multi-PR plan (e.g., Notion
auth as PR 1 of 3) AS LONG AS the staged plan was pre-approved in the
issue by a maintainer.

## Changing environment variables

This is the most operationally sensitive rule on the API repo because
production auto-deploys on every push to `main`. **If your PR adds,
renames, or removes any env var that the API actually reads, it does
NOT merge until that var is live on the production VPS.** Skipping
this has already taken production down (api PR #52, Google OAuth)
when a strategy's constructor crashed at bootstrap on a missing
`GOOGLE_CLIENT_ID`.

What this looks like in practice:

- Call out the new env vars at the top of the PR description in a
  `### Required env vars` section, with one bullet per var explaining
  what it is and where the value should come from.
- Mirror the new vars in `.env.example` with a clear placeholder so
  other contributors can run the feature locally.
- Add the var to `src/shared/configuration/env.validation.ts` so the
  app fails loudly at startup with a clear error rather than crashing
  mid-bootstrap with an opaque stack.
- If your code reads the new var in a module-level constructor (a
  Passport strategy's `super({ clientID: ... })`, a service that
  initializes a third-party SDK at construction, etc.), guard the
  provider so it does NOT register when the var is missing. Otherwise
  a missing var crashes the whole API at bootstrap, not just the new
  feature. Pattern:
  ```ts
  // In auth.module.ts (or similar)
  const googleProviders =
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [GoogleStrategy]
      : [];
  providers: [AuthService, JwtStrategy, ...googleProviders],
  ```
  The corresponding controller route should return `503 Provider not
  configured` when the strategy is not registered, not 500.
- Tag the maintainer (@ZeeshanAdilButt) in the PR comments and wait
  for explicit confirmation that the production env has been updated
  before you merge.

**You merge your own PR once the maintainer confirms the env is live.**
Maintainers do not press the merge button on contributor PRs, they
approve and let the contributor merge when production is ready to
receive the change.

## Database migrations

- New migrations go in `prisma/migrations/` with a clear name like
  `20260604_add_whiteboard_share_revoked_at`.
- Always run `pnpm prisma migrate dev` locally to generate the migration
  before committing. Do not edit a generated migration after it has
  been merged.
- Production migrations apply on every push to `main` via the deploy
  pipeline. If your migration is destructive (drops a column, drops a
  table, changes a type that loses precision), flag it in the PR body
  and the maintainer will plan the deploy window.

## Comment style on PRs and issues

Write like a human who wants the next contributor to learn from this
thread. Useful over thorough. Lightly structured if needed. Avoid:

- `--` (double dashes), em-dashes (—), curly quotes, AI tells like
  "Certainly!" or "I'd be happy to".
- Long unstructured paragraphs that bury the point.
- Restating the diff in prose. The diff is the diff.

## Code review

- A maintainer will review within ~48 hours during the week.
- Address every comment. If you disagree with a comment, push back in
  the thread, do not just ignore it.
- After you push fixes, re-request review by re-pinging the maintainer
  with a short note like `Pushed the changes you asked for, ready when
  you are`.

## CodeRabbit

We have CodeRabbit attached to PRs. Its output is auto-review noise.
**Maintainers ignore it and so should you.** Do not respond to its
comments and do not feel pressured to address its suggestions unless a
human maintainer specifically points to one.

## Local setup

See [README.md](README.md) for the API local dev setup (Postgres,
environment variables, Prisma, seeds). The web repo has its own
[CONTRIBUTING.md](https://github.com/ZeeshanAdilButt/goal-slot-web/blob/main/CONTRIBUTING.md)
with the frontend setup steps.

## Questions

Open a discussion or comment on the relevant issue. Do not DM
maintainers directly for technical questions. Keeping the discussion
on the issue helps the next contributor.
