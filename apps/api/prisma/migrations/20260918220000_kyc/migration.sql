-- Identity checks, reviewed by an operator. One row per player rather than one
-- per attempt: what matters operationally is the current standing, and the
-- history of decisions is in the audit log with every other operator action.
--
-- Document bytes stay out of Postgres on purpose. The row carries a path
-- inside a configured directory, which keeps passport scans out of every
-- backup, replica and query log that touches the database.

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "KycDocumentKind" AS ENUM ('PASSPORT', 'ID_CARD', 'DRIVING_LICENCE', 'SELFIE', 'PROOF_OF_ADDRESS');

-- CreateTable
CREATE TABLE "kyc_applications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "documentNo" TEXT NOT NULL,
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "kind" "KycDocumentKind" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_applications_userId_key" ON "kyc_applications"("userId");
CREATE INDEX "kyc_applications_status_submittedAt_idx" ON "kyc_applications"("status", "submittedAt");
CREATE INDEX "kyc_documents_applicationId_idx" ON "kyc_documents"("applicationId");

-- AddForeignKey
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "kyc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
