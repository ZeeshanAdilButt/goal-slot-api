-- CreateTable
CREATE TABLE "NotionPageIndex" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notionPageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotionPageIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotionPageIndex_userId_notionPageId_key" ON "NotionPageIndex"("userId", "notionPageId");

-- CreateIndex
CREATE INDEX "NotionPageIndex_userId_idx" ON "NotionPageIndex"("userId");

-- CreateIndex
CREATE INDEX "NotionPageIndex_userId_indexedAt_idx" ON "NotionPageIndex"("userId", "indexedAt");

-- AddForeignKey
ALTER TABLE "NotionPageIndex" ADD CONSTRAINT "NotionPageIndex_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
