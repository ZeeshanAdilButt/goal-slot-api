# GoalSlot API

NestJS + Prisma backend for the GoalSlot productivity app.

## Coach API

Coach is a Socratic productivity layer built on user-provided OpenAI or Anthropic keys (BYOK). All keys are encrypted at rest with AES-256-GCM.

### Required env var

```
BYOK_ENCRYPTION_KEY=<base64 32-byte AES-256 key>
```

`BYOK_ENCRYPTION_KEY` is the symmetric key used to encrypt every saved BYOK provider key in `EncryptedByokKey`. Generate one with:

```
openssl rand -base64 32
```

**Production must use a separate value stored as a Vercel/Supabase env secret, never reused from dev.** Rotating this value invalidates every previously stored BYOK key (users will need to re-enter theirs).

### Routes

See [`docs/coach-api.md`](docs/coach-api.md) for the full route surface — BYOK, habits profile, daily check-ins, goal reflections, journal, and the streaming Coach AI endpoints.

### Rate limits

- **30 AI requests / 24h / user** — enforced by a per-user `ThrottlerGuard` keyed on `req.user.sub`. Hits return `429`.
- **100,000 tokens / month / user** (default) — tracked in `EncryptedByokKey.tokensUsedThisMonth`, auto-resets every 30 days. Hits return `429` with `{ tokensUsed, tokensLimit }` in the body.
- The narrative cache (existing message for a given `scopeKey`) is served without invoking the LLM or counting against either budget.
