-- Deezer, Last.fm profiles and the leaderboard are gone: drop what only they used.
-- A song with no Apple id has no audio any more, so it leaves the pool.
UPDATE "Track" SET "inPool" = false WHERE "itunesId" IS NULL;

-- DropForeignKey
ALTER TABLE "ProfileTrack" DROP CONSTRAINT "ProfileTrack_profileId_fkey";

-- DropForeignKey
ALTER TABLE "ProfileTrack" DROP CONSTRAINT "ProfileTrack_trackId_fkey";

-- DropForeignKey
ALTER TABLE "_RunProfiles" DROP CONSTRAINT "_RunProfiles_A_fkey";

-- DropForeignKey
ALTER TABLE "_RunProfiles" DROP CONSTRAINT "_RunProfiles_B_fkey";

-- DropIndex
DROP INDEX "Run_finishedAt_totalScore_idx";

-- DropIndex
DROP INDEX "Track_deezerId_key";

-- DropIndex
DROP INDEX "Track_isrc_key";

-- AlterTable
ALTER TABLE "Run" DROP COLUMN "nickname";

-- AlterTable
ALTER TABLE "Track" DROP COLUMN "deezerId",
DROP COLUMN "isrc";

-- DropTable
DROP TABLE "Profile";

-- DropTable
DROP TABLE "ProfileTrack";

-- DropTable
DROP TABLE "_RunProfiles";

-- DropEnum
DROP TYPE "ImportStatus";

