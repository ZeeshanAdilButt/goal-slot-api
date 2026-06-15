-- CreateTable
CREATE TABLE "Whiteboard" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "content" JSONB NOT NULL DEFAULT '{"elements":[],"appState":{},"files":{}}',
    "icon" TEXT,
    "color" TEXT,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "publicShareToken" TEXT,
    "userId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedReason" TEXT,
    "deletedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Whiteboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteboardShare" (
    "id" TEXT NOT NULL,
    "whiteboardId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "permission" TEXT NOT NULL DEFAULT 'VIEW',
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhiteboardShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Whiteboard_publicShareToken_key" ON "Whiteboard"("publicShareToken");

-- CreateIndex
CREATE INDEX "Whiteboard_userId_idx" ON "Whiteboard"("userId");

-- CreateIndex
CREATE INDEX "Whiteboard_isFavorite_idx" ON "Whiteboard"("isFavorite");

-- CreateIndex
CREATE INDEX "WhiteboardShare_recipientUserId_idx" ON "WhiteboardShare"("recipientUserId");

-- CreateIndex
CREATE INDEX "WhiteboardShare_recipientEmail_idx" ON "WhiteboardShare"("recipientEmail");

-- CreateIndex
CREATE INDEX "WhiteboardShare_ownerId_idx" ON "WhiteboardShare"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "WhiteboardShare_whiteboardId_recipientEmail_key" ON "WhiteboardShare"("whiteboardId", "recipientEmail");

-- AddForeignKey
ALTER TABLE "Whiteboard" ADD CONSTRAINT "Whiteboard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteboardShare" ADD CONSTRAINT "WhiteboardShare_whiteboardId_fkey" FOREIGN KEY ("whiteboardId") REFERENCES "Whiteboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteboardShare" ADD CONSTRAINT "WhiteboardShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteboardShare" ADD CONSTRAINT "WhiteboardShare_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
