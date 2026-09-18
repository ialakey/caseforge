-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "categoryId" UUID;

-- CreateTable
CREATE TABLE "case_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_categories_slug_key" ON "case_categories"("slug");

-- CreateIndex
CREATE INDEX "case_categories_isActive_sortOrder_idx" ON "case_categories"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "cases_categoryId_sortOrder_idx" ON "cases"("categoryId", "sortOrder");

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "case_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

