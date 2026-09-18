-- A case carries its own copy in both locales. Nullable throughout: every
-- case that exists today has no description, and back-filling prose with a
-- default would be worse than an empty paragraph the storefront can skip.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "description" TEXT,
ADD COLUMN     "descriptionEn" TEXT;
