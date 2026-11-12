-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('PLAYING', 'SOLVED', 'GIVEN_UP');

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "deezerId" BIGINT NOT NULL,
    "isrc" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "coverUrl" TEXT,
    "rank" INTEGER NOT NULL,
    "songKey" TEXT NOT NULL,
    "inPool" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackSource" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "nickname" TEXT,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "trackId" TEXT NOT NULL,
    "unlockedSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "wrongGuesses" INTEGER NOT NULL DEFAULT 0,
    "status" "RoundStatus" NOT NULL DEFAULT 'PLAYING',
    "score" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guess" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "guessedTrackId" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "unlockedSeconds" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Track_deezerId_key" ON "Track"("deezerId");

-- CreateIndex
CREATE UNIQUE INDEX "Track_isrc_key" ON "Track"("isrc");

-- CreateIndex
CREATE INDEX "Track_inPool_rank_idx" ON "Track"("inPool", "rank");

-- CreateIndex
CREATE INDEX "Track_songKey_idx" ON "Track"("songKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrackSource_trackId_kind_reference_key" ON "TrackSource"("trackId", "kind", "reference");

-- CreateIndex
CREATE INDEX "Run_finishedAt_totalScore_idx" ON "Run"("finishedAt", "totalScore");

-- CreateIndex
CREATE UNIQUE INDEX "Round_runId_index_key" ON "Round"("runId", "index");

-- AddForeignKey
ALTER TABLE "TrackSource" ADD CONSTRAINT "TrackSource_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guess" ADD CONSTRAINT "Guess_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guess" ADD CONSTRAINT "Guess_guessedTrackId_fkey" FOREIGN KEY ("guessedTrackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
