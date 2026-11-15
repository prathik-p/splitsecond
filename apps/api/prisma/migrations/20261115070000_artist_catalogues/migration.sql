-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "catalogOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ArtistImport" (
    "itunesId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "albumsDone" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistImport_pkey" PRIMARY KEY ("itunesId")
);

-- CreateIndex
CREATE INDEX "ArtistImport_query_idx" ON "ArtistImport"("query");
