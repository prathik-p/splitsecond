-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "itunesId" BIGINT,
ADD COLUMN     "previewUrl" TEXT,
ALTER COLUMN "deezerId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Track_itunesId_key" ON "Track"("itunesId");

