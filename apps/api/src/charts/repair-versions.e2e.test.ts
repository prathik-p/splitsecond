/**
 * Fixing songs in the pool that an older seed matched to a live or livestream
 * version. Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { songKey } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { CatalogTrack } from "../catalog/types";
import { repairVersions } from "./repair-versions";

const ID = 960_000_000;
const ARTIST = "twenty one pilots";

const found = (n: number, title: string, album: string, year: number): CatalogTrack => ({
  id: String(ID + n),
  title,
  artist: ARTIST,
  album,
  coverUrl: `https://example.test/${n}.jpg`,
  rank: 0,
  releaseDate: `${year}-05-15T07:00:00Z`,
  previewUrl: `https://example.test/${n}.m4a`,
  playable: true,
});

// What a search for each title turns up.
const catalog: Record<string, CatalogTrack[]> = {
  "Stressed Out": [
    found(1, "Stressed Out", "Scaled And Icy (Livestream Version)", 2021),
    found(2, "Stressed Out", "Blurryface", 2015),
  ],
  Heathens: [found(3, "Heathens", "Scaled And Icy (Livestream Version)", 2021), found(4, "Heathens", "Suicide Squad: The Album", 2016)],
  "Car Radio": [found(5, "Car Radio", "Scaled And Icy (Livestream Version)", 2021)],
  Ride: [found(7, "Ride", "Scaled And Icy (Livestream Version)", 2021), found(8, "Ride", "Blurryface", 2015)],
};
const searches: string[] = [];
const fake = {
  search: async (title: string) => {
    searches.push(title);
    return catalog[title] ?? [];
  },
};

describe.skipIf(!process.env.DATABASE_URL)("repairing other versions in the pool", () => {
  let prisma: PrismaService;
  const mine = { itunesId: { gte: BigInt(ID), lt: BigInt(ID + 1000) } };
  const runIds: string[] = [];
  let previousPool: string[] = [];

  const saved = (n: number, title: string, album: string, extra: { catalogOnly?: boolean; year?: number; rank?: number } = {}) =>
    prisma.track.create({
      data: {
        itunesId: BigInt(ID + n),
        title,
        artist: ARTIST,
        album,
        rank: extra.rank ?? 500_000,
        year: extra.year ?? 2016,
        songKey: songKey(title, ARTIST),
        catalogOnly: extra.catalogOnly ?? false,
        sources: { create: { kind: extra.catalogOnly ? "artist" : "billboard", reference: `test:${n}` } },
      },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.track.deleteMany({ where: mine });
    previousPool = (await prisma.track.findMany({ where: { inPool: true }, select: { id: true } })).map((t) => t.id);
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: false } });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.track.deleteMany({ where: mine });
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: true } });
    await prisma.$disconnect();
  });

  it("swaps hits for the original, takes out what has none, and leaves the rest alone", async () => {
    const stressed = await saved(1, "Stressed Out", "Scaled And Icy (Livestream Version)");
    const heathens = await saved(3, "Heathens", "Scaled And Icy (Livestream Version)");
    const carRadio = await saved(5, "Car Radio", "Scaled And Icy (Livestream Version)");
    const deepCut = await saved(6, "Shy Away (Livestream Version)", "Scaled And Icy (Livestream Version)", { catalogOnly: true });
    // "Ride" is a hit on the livestream album, and the original is already in from the artist catalogue.
    const ride = await saved(7, "Ride", "Scaled And Icy (Livestream Version)", { rank: 700_000 });
    const rideOriginal = await saved(8, "Ride", "Blurryface", { catalogOnly: true, year: 2015, rank: 20_000 });
    const fine = await saved(9, "Chlorine", "Trench");
    // A played run points at "Car Radio", so its row has to stay.
    const run = await prisma.run.create({ data: { rounds: { create: { index: 0, trackId: carRadio.id } } } });
    runIds.push(run.id);

    const log: string[] = [];
    const result = await repairVersions(prisma, fake, { log: (m) => log.push(m) });
    expect(result).toEqual({ swapped: 3, removed: 2, stopped: false });
    expect(searches).toEqual(["Stressed Out", "Heathens", "Car Radio", "Ride"]); // never for the deep cut or the fine song

    // The same row, now playing the original, keeping its chart year, rank and source.
    expect(await prisma.track.findUnique({ where: { id: stressed.id }, include: { sources: true } })).toMatchObject({
      itunesId: BigInt(ID + 2),
      album: "Blurryface",
      previewUrl: "https://example.test/2.m4a",
      year: 2016,
      rank: 500_000,
      inPool: true,
      sources: [expect.objectContaining({ kind: "billboard" })],
    });
    expect(await prisma.track.findUnique({ where: { id: heathens.id } })).toMatchObject({ album: "Suicide Squad: The Album" });

    // No original anywhere, and a run points at it: out of the pool, and no seed will match it again.
    const car = await prisma.track.findUniqueOrThrow({ where: { id: carRadio.id }, include: { sources: true } });
    expect(car).toMatchObject({ inPool: false, sources: [] });
    expect(car.songKey).not.toBe(songKey("Car Radio", ARTIST));

    // A catalogue song that is another version is simply deleted.
    expect(await prisma.track.findUnique({ where: { id: deepCut.id } })).toBeNull();

    // The original already saved takes over as the hit; the livestream row goes.
    expect(await prisma.track.findUnique({ where: { id: ride.id } })).toBeNull();
    expect(await prisma.track.findUnique({ where: { id: rideOriginal.id }, include: { sources: true } })).toMatchObject({
      inPool: true,
      catalogOnly: false,
      rank: 700_000,
      year: 2015,
    });
    expect((await prisma.trackSource.findMany({ where: { trackId: rideOriginal.id } })).map((s) => s.kind).sort()).toEqual([
      "artist",
      "billboard",
    ]);

    expect(await prisma.track.findUnique({ where: { id: fine.id } })).toMatchObject({ inPool: true, album: "Trench" });
    expect(log[0]).toBe("5 songs are another version (live, livestream, remix…); fixing");

    // Nothing left to fix the second time.
    searches.length = 0;
    expect(await repairVersions(prisma, fake)).toEqual({ swapped: 0, removed: 0, stopped: false });
    expect(searches).toEqual([]);
  });
});
