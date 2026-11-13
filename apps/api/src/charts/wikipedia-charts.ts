/**
 * Billboard's Year-End Hot 100 lists, read from Wikipedia. Each year has a page
 * with one table of 100 rows: position, title, artist(s). The pages are fetched
 * through Wikipedia's API as rendered HTML, which is the same shape for every
 * year however the page's wikitext is written.
 */

export interface ChartEntry {
  position: number;
  title: string;
  artist: string;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—" };

function text(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "") // footnote markers
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A table's rows as plain-text cells, with rowspans filled in on the rows they cover. */
function tableRows(tableHtml: string): { cells: string[]; header: boolean }[] {
  const rows: { cells: string[]; header: boolean }[] = [];
  const spanning = new Map<number, { value: string; left: number }>();
  for (const row of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const raw = [...row[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)];
    if (raw.length === 0) continue;
    const cells: string[] = [];
    let next = 0;
    const fillSpans = () => {
      for (let span = spanning.get(cells.length); span; span = spanning.get(cells.length)) {
        const column = cells.length;
        cells.push(span.value);
        if (--span.left === 0) spanning.delete(column);
      }
    };
    fillSpans();
    while (next < raw.length) {
      const [, , attrs, inner] = raw[next++];
      const value = text(inner);
      const rowspan = Number(/rowspan="?(\d+)/i.exec(attrs)?.[1] ?? 1);
      const colspan = Number(/colspan="?(\d+)/i.exec(attrs)?.[1] ?? 1);
      for (let c = 0; c < colspan; c++) {
        if (rowspan > 1) spanning.set(cells.length, { value, left: rowspan - 1 });
        cells.push(value);
      }
      fillSpans();
    }
    rows.push({ cells, header: raw.every((cell) => cell[1].toLowerCase() === "th") });
  }
  return rows;
}

function cleanTitle(raw: string): string {
  // Double A-sides are listed as "One" / "Two": the first is the one to find.
  const first = raw.split(/["”]\s*\/\s*["“]/)[0];
  return first.replace(/^["“”']+|["“”']+$/g, "").trim();
}

/** Pull the chart out of a year-end page: the table with the most position/title/artist rows. */
export function parseYearEndPage(html: string): ChartEntry[] {
  let best: ChartEntry[] = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = tableRows(table[1]);
    const header = rows.find((r) => r.header)?.cells.map((c) => c.toLowerCase()) ?? [];
    let titleAt = header.findIndex((c) => /title|song|single/.test(c));
    let artistAt = header.findIndex((c) => /artist/.test(c));
    let positionAt = header.findIndex((c) => /^(no\.?|№|#|rank|pos)/.test(c));
    if (titleAt < 0 || artistAt < 0) [positionAt, titleAt, artistAt] = [0, 1, 2];
    if (positionAt < 0) positionAt = 0;

    const entries: ChartEntry[] = [];
    for (const row of rows) {
      if (row.header) continue;
      const position = Number.parseInt(row.cells[positionAt] ?? "", 10);
      const title = cleanTitle(row.cells[titleAt] ?? "");
      const artist = (row.cells[artistAt] ?? "").trim();
      if (!Number.isInteger(position) || position < 1 || position > 200 || !title || !artist) continue;
      entries.push({ position, title, artist });
    }
    if (entries.length > best.length) best = entries;
  }
  return best.sort((a, b) => a.position - b.position);
}

export class WikipediaCharts {
  constructor(private readonly apiUrl = "https://en.wikipedia.org/w/api.php") {}

  /** The Billboard Year-End Hot 100 for a year, or [] if Wikipedia has no page for it yet. */
  async yearEnd(year: number): Promise<ChartEntry[]> {
    const url = new URL(this.apiUrl);
    url.search = new URLSearchParams({
      action: "parse",
      page: `Billboard_Year-End_Hot_100_singles_of_${year}`,
      prop: "text",
      format: "json",
      formatversion: "2",
      redirects: "1",
    }).toString();
    // Wikipedia asks API clients to identify themselves.
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "song-game-seeder/1.0" } });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    const body = (await res.json()) as { parse?: { text?: string | { "*": string } }; error?: { code?: string; info?: string } };
    if (body.error) {
      if (body.error.code === "missingtitle") return [];
      throw new Error(`Wikipedia: ${body.error.info ?? body.error.code}`);
    }
    const html = typeof body.parse?.text === "string" ? body.parse.text : (body.parse?.text?.["*"] ?? "");
    return parseYearEndPage(html);
  }
}
