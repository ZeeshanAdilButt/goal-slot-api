-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "refreshCiphertext" BYTEA NOT NULL,
    "refreshIv" BYTEA NOT NULL,
    "refreshAuthTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedCalendarEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalCalId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "scheduleBlockId" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedCalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarConnection_userId_idx" ON "CalendarConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_userId_provider_key" ON "CalendarConnection"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedCalendarEvent_scheduleBlockId_key" ON "ImportedCalendarEvent"("scheduleBlockId");

-- CreateIndex
CREATE INDEX "ImportedCalendarEvent_connectionId_idx" ON "ImportedCalendarEvent"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedCalendarEvent_connectionId_externalEventId_key" ON "ImportedCalendarEvent"("connectionId", "externalEventId");

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedCalendarEvent" ADD CONSTRAINT "ImportedCalendarEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedCalendarEvent" ADD CONSTRAINT "ImportedCalendarEvent_scheduleBlockId_fkey" FOREIGN KEY ("scheduleBlockId") REFERENCES "ScheduleBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
