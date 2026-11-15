-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "artists" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "genres" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "genre" TEXT;
