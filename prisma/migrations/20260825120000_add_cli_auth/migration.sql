-- CLI authentication: pending login sessions and long-lived CLI credentials.
--
-- Purely additive. Two new enums, two new tables, no change to any existing
-- table or column, so `prisma migrate deploy` on production cannot drop or
-- rewrite anything. The new relations on "User" are Prisma-side only; they are
-- backed by the foreign keys declared here on the new tables.

-- CreateEnum
CREATE TYPE "CliAuthMode" AS ENUM ('LOOPBACK', 'DEVICE');

-- CreateEnum
CREATE TYPE "CliAuthStatus" AS ENUM ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED', 'EXPIRED');

-- CreateTable
CREATE TABLE "CliToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientVersion" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'full',
    "createdIp" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CliToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CliAuthSession" (
    "id" TEXT NOT NULL,
    "mode" "CliAuthMode" NOT NULL,
    "status" "CliAuthStatus" NOT NULL DEFAULT 'PENDING',
    "sessionSecretHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "redirectUri" TEXT,
    "authorizationCodeHash" TEXT,
    "authorizationCodeExpiresAt" TIMESTAMP(3),
    "state" TEXT,
    "userCode" TEXT,
    "clientName" TEXT NOT NULL,
    "clientVersion" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'full',
    "requestIp" TEXT,
    "requestUserAgent" TEXT,
    "userId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliTokenId" TEXT,

    CONSTRAINT "CliAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CliToken_refreshTokenHash_key" ON "CliToken"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CliToken_previousRefreshTokenHash_key" ON "CliToken"("previousRefreshTokenHash");

-- CreateIndex
CREATE INDEX "CliToken_userId_revokedAt_idx" ON "CliToken"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "CliToken_expiresAt_idx" ON "CliToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CliAuthSession_userCode_key" ON "CliAuthSession"("userCode");

-- CreateIndex
CREATE UNIQUE INDEX "CliAuthSession_cliTokenId_key" ON "CliAuthSession"("cliTokenId");

-- CreateIndex
CREATE INDEX "CliAuthSession_status_expiresAt_idx" ON "CliAuthSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CliAuthSession_userId_idx" ON "CliAuthSession"("userId");

-- AddForeignKey
ALTER TABLE "CliToken" ADD CONSTRAINT "CliToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CliAuthSession" ADD CONSTRAINT "CliAuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CliAuthSession" ADD CONSTRAINT "CliAuthSession_cliTokenId_fkey" FOREIGN KEY ("cliTokenId") REFERENCES "CliToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
