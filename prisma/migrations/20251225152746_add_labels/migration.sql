-- AlterTable
ALTER TABLE "User" ADD COLUMN     "firstPaymentDate" TIMESTAMP(3),
ADD COLUMN     "invoicePending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastInvoiceId" TEXT,
ADD COLUMN     "lastPaymentDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalLabel" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Label_userId_idx" ON "Label"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_userId_value_key" ON "Label"("userId", "value");

-- CreateIndex
CREATE INDEX "GoalLabel_goalId_idx" ON "GoalLabel"("goalId");

-- CreateIndex
CREATE INDEX "GoalLabel_labelId_idx" ON "GoalLabel"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "GoalLabel_goalId_labelId_key" ON "GoalLabel"("goalId", "labelId");

-- CreateIndex
CREATE INDEX "Goal_category_idx" ON "Goal"("category");

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalLabel" ADD CONSTRAINT "GoalLabel_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalLabel" ADD CONSTRAINT "GoalLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
