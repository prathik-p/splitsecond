/**
 * What counts as "the song" when an artist's whole catalogue is added: the
 * original studio recording from an album, EP or single. Remixes, live
 * recordings, acoustic and demo takes, sped-up edits and the like are another
 * version of a song, not another song, and are left out, as are whole live,
 * remix and karaoke releases.
 *
 * A remaster, a radio edit, an explicit/clean pair or a "(X's Version)"
 * re-recording is still the same song; those are folded into one entry by the
 * seeder rather than rejected here.
 */

/** Words that mark a different version, when they appear in a bracket or after a dash. */
const ALTERNATE =
  /\b(remix(?:es|ed)?|rmx|re-?work(?:ed)?|live|acoustic|demos?|instrumentals?|karaoke|a\s?cappella|sped[- ]up|slowed|reverb|nightcore|stripped|unplugged|piano|orchestral|symphonic|extended|dub|bootleg|mash-?up|medley|rehearsal|sessions?|commentary|interview|voice memo|skit|outtake|alternate|alternative|rough|work tape|take \d+|performance|recorded (?:at|in|live)|concert|festival|bbc|spotify|vevo|apple music|itunes|mtv)\b/i;
/** "Mix" and "edit" are fine when they only name the standard cut. */
const STANDARD_MIX = /\b(single|album|radio|original|stereo|mono|\d{4})\s+mix\b/i;
const STANDARD_EDIT = /\b(radio|single|album|clean|explicit)\s+edit\b/i;
/** Not a song at all, wherever the words appear. */
const NOT_A_SONG = /\b(commentary|voice memo|interview|karaoke|track by track|spoken word)\b/i;
/** A guest credit can contain any word ("feat. Piano Guys"); it says nothing about the version. */
const GUESTS = /\b(feat\.?|ft\.?|featuring|with)\s.*$/i;

const BRACKETS = /[([]([^)\]]*)[)\]]/g;

/** The bolted-on parts of a title: each bracket's contents, and whatever follows " - ". */
function decorations(name: string): string[] {
  const out = [...name.matchAll(BRACKETS)].map((m) => m[1]);
  const tail = /\s[-–—]\s+(.+)$/.exec(name.replace(BRACKETS, " "));
  if (tail) out.push(tail[1]);
  return out.map((d) => d.replace(GUESTS, "").trim()).filter(Boolean);
}

function marksAlternate(decoration: string): boolean {
  if (ALTERNATE.test(decoration)) return true;
  if (/\bmix\b/i.test(decoration) && !STANDARD_MIX.test(decoration)) return true;
  if (/\bedit\b/i.test(decoration) && !STANDARD_EDIT.test(decoration)) return true;
  return false;
}

/** True for a remix, live take, acoustic or demo version, or anything else that isn't the original recording. */
export function isAlternateVersion(title: string): boolean {
  if (NOT_A_SONG.test(title)) return true;
  if (/\bremix$/i.test(title.replace(BRACKETS, " ").trim())) return true;
  return decorations(title).some(marksAlternate);
}

/** Releases known by name to hold no original recordings, even without a bracket. */
const ALTERNATE_RELEASE =
  /\blive (?:at|from|in|on)\b|\blive$|\b(?:remixes|remixed|the remix|remix (?:ep|album)|karaoke|unplugged|instrumentals|a\s?cappella|commentary|studio sessions?)\b|\b(?:spotify|itunes|apple music|bbc|amazon|vevo|mtv)\b.*\b(?:live|sessions?|singles|festival)\b/i;

/** True for a live album, a remix EP, a karaoke or instrumental release, a streaming-service session. */
export function isAlternateRelease(name: string): boolean {
  const bare = name.replace(/\s[-–—]\s+(single|ep)$/i, "");
  return ALTERNATE_RELEASE.test(bare.replace(BRACKETS, " ").trim()) || decorations(bare).some(marksAlternate);
}
