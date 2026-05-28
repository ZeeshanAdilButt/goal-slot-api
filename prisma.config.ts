import "dotenv/config";
import { defineConfig } from "prisma/config";

// We deliberately avoid Prisma's `env()` helper here. It THROWS at
// config-parse time when DATABASE_URL is unset, which happens during
// platform build steps (Render, Vercel, GitHub Actions Docker build)
// where env vars are injected at *runtime*, not at build. That throw
// was breaking the production deploy pipeline — Render's build kept
// failing during `prisma generate`, so the service stayed pinned on
// the last-successful image (January, pre-coach module). The result:
// /api/coach/* returning 404 in production for months.
//
// Plain `process.env.DATABASE_URL` is safe — at runtime the real
// value is present; at build time the fallback is used only to let
// the config parse, never to actually connect.
const BUILD_TIME_STUB = "postgresql://stub:stub@localhost:5432/stub";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node -r tsconfig-paths/register prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? BUILD_TIME_STUB,
  },
});
