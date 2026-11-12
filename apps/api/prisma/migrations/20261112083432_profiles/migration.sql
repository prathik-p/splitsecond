-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileTrack" (
    "profileId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "playcount" INTEGER NOT NULL DEFAULT 0,
    "loved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProfileTrack_pkey" PRIMARY KEY ("profileId","trackId")
);

-- CreateTable
CREATE TABLE "_RunProfiles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RunProfiles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_source_username_key" ON "Profile"("source", "username");

-- CreateIndex
CREATE INDEX "ProfileTrack_trackId_idx" ON "ProfileTrack"("trackId");

-- CreateIndex
CREATE INDEX "_RunProfiles_B_index" ON "_RunProfiles"("B");

-- AddForeignKey
ALTER TABLE "ProfileTrack" ADD CONSTRAINT "ProfileTrack_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileTrack" ADD CONSTRAINT "ProfileTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RunProfiles" ADD CONSTRAINT "_RunProfiles_A_fkey" FOREIGN KEY ("A") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RunProfiles" ADD CONSTRAINT "_RunProfiles_B_fkey" FOREIGN KEY ("B") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
