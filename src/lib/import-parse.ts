import { validateGameId } from '@/lib/validation';

/**
 * Library import parsing.
 *
 * Onboarding is the single biggest reason people abandon a tracker: adding 200
 * games one dialog at a time is not an experience anyone will accept. So the
 * import path has to accept what people actually have.
 *
 * Three formats, because those are the three people actually have:
 *
 *   - **CSV** from a spreadsheet or another tracker
 *   - **Backlog XML** — the most common gaming-library export, plain `<game>`
 *     elements with child nodes
 *   - **Raw newline list** — just titles, one per line, which is what you end up
 *     with when you copy-paste from anywhere
 *
 * ── The design rule that matters ────────────────────────────────────────────
 *
 * This module **never writes**. It returns a plan the user reviews, and a
 * separate action performs the writes. An import that runs immediately is
 * unrecoverable from the user's side: a malformed file can overwrite ratings,
 * clobber reviews someone spent an hour writing, and there is no undo. So the
 * two phases are separate functions in separate files on purpose.
 */

/** One parsed row, before it is matched against the database. */
export type ParsedRow = {
  /** Row number in the source file, for error messages. 1-based. */
  line: number;
  title: string;
  rating: number | null;
  status: 'backlog' | 'playing' | 'completed' | 'abandoned' | null;
  playedOn: string | null;
  review: string | null;
  playtimeHours: number | null;
};

export type ParseIssue = {
  line: number;
  message: string;
  /** Whatever was understood from the row, so the user can see what was kept. */
  title?: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  issues: ParseIssue[];
  /** Total data lines seen, including rejected ones. */
  total: number;
};

/** Hard ceilings. An import is a bulk operation; without these it is a DoS. */
export const IMPORT_MAX_ROWS = 2000;
const MAX_TITLE_LENGTH = 200;
const MAX_REVIEW_LENGTH = 2000;

const STATUS_ALIASES: Record<string, ParsedRow['status']> = {
  backlog: 'backlog',
  want: 'backlog',
  'want to play': 'backlog',
  wishlist: 'backlog',
  plan: 'backlog',
  'plan to play': 'backlog',
  playing: 'playing',
  current: 'playing',
  'currently playing': 'playing',
  'in progress': 'playing',
  completed: 'completed',
  complete: 'completed',
  finished: 'completed',
  played: 'completed',
  beaten: 'completed',
  abandoned: 'abandoned',
  dropped: 'abandoned',
  quit: 'abandoned',
};

/**
 * Accepts 0–10, a percentage out of 10 or 100, or a 5-star value.
 *
 * Exports are wildly inconsistent: one tracker writes `8`, another `0.8`,
 * another `4/5`. Rejecting them all would make the feature useless, so the
 * convention is inferred from the magnitude. Values above 10 are assumed to be
 * percentages; anything in 0–5 is assumed to be out of five.
 */
export function parseRating(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;

  const text = String(raw).trim();
  // `8/10`, `4/5` — take the numerator.
  const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const [, num, den] = fraction;
    const d = Number(den);
    if (d === 0) return null;
    return clampRating((Number(num) / d) * 10);
  }

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;

  // A star rating out of five. Chosen because a genuine 0–5 rating is far rarer
  // than a 5-star export.
  if (n > 0 && n <= 5 && Number.isInteger(n)) return n * 2;

  if (n > 10) return n <= 100 ? Math.round(n / 10) : null;

  return clampRating(n);
}

function clampRating(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n)));
}

/** Accepts several date shapes and returns `YYYY-MM-DD`, or null. */
export function parseDate(raw: unknown): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Already ISO.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const date = `${y}-${m}-${d}`;
    return isRealDate(date) ? date : null;
  }

  // `YYYY/MM/DD` or `DD/MM/YYYY`.
  const slashed = text.match(/^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/);
  if (slashed) {
    const [, a, b, c] = slashed;
    // Disambiguate: a 4-digit first group is a year.
    if (a.length === 4) {
      const date = `${a}-${pad(b)}-${pad(c)}`;
      return isRealDate(date) ? date : null;
    }
    if (c.length === 4) {
      const date = `${c}-${pad(b)}-${pad(a)}`;
      return isRealDate(date) ? date : null;
    }
    return null;
  }

  // `MonthName DD, YYYY` / `DD MonthName YYYY`.
  //
  // The local date components are read rather than `toISOString()`. `new Date`
  // parses a bare date string as *local* midnight, so in any timezone behind UTC
  // `toISOString()` returns the **previous** day — "March 4, 2024" silently
  // imported as 2024-03-03. Reading getFullYear/getMonth/getDate keeps the day
  // the user actually wrote.
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const date =
      `${parsed.getFullYear()}-${pad(String(parsed.getMonth() + 1))}-` +
      `${pad(String(parsed.getDate()))}`;
    return isRealDate(date) ? date : null;
  }

  return null;
}

function pad(n: string): string {
  return n.padStart(2, '0');
}

function isRealDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function parseStatus(raw: unknown): ParsedRow['status'] | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return STATUS_ALIASES[key] ?? null;
}

function parseHours(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  // Some exports write `12:30` for twelve and a half hours.
  const text = String(raw).trim();
  const clock = text.match(/^(\d+):(\d{2})$/);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    return h + m / 60;
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && n <= 9999 ? Math.round(n * 10) / 10 : null;
}

/**
 * Splits one CSV line, honouring quoted fields and escaped quotes.
 *
 * A regex-based `split(',')` is the usual mistake here and corrupts any review
 * containing a comma — which is most reviews.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++; // consume the pair
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }

  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Guesses the column mapping from a header row.
 *
 * Every tracker names its columns differently, so asking the user to map twelve
 * columns before they have imported anything is how an import flow gets
 * abandoned. Instead each field is matched against a list of known aliases, and
 * the result is shown for review before anything is written.
 */
const COLUMN_ALIASES: Record<keyof Omit<ParsedRow, 'line'>, string[]> = {
  title: ['title', 'name', 'game', 'game title', 'gamename', 'game name'],
  rating: ['rating', 'score', 'stars', 'rating10', 'my rating'],
  status: ['status', 'state', 'completion', 'play status'],
  playedOn: ['playedon', 'played on', 'dateplayed', 'date played', 'date', 'lastplayed', 'last played'],
  review: ['review', 'notes', 'comment', 'comments', 'reviewtext', 'review text'],
  playtimeHours: ['playtime', 'playtimehours', 'hours', 'hoursplayed', 'play time', 'minutesplayed'],
};

export type ColumnMapping = Partial<Record<keyof Omit<ParsedRow, 'line'>, number>>;

/** Returns the header row and a best-guess mapping. */
export function detectColumns(
  header: string
): { mapping: ColumnMapping; unmapped: string[] } {
  const headers = splitCsvLine(header).map((h) =>
    h.toLowerCase().replace(/[\s_-]+/g, ' ').trim()
  );

  const mapping: ColumnMapping = {};
  const used = new Set<number>();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
    keyof ColumnMapping,
    string[],
  ][]) {
    const index = headers.findIndex(
      (h, i) => !used.has(i) && aliases.some((a) => h === a || h.includes(a))
    );
    if (index !== -1) {
      mapping[field] = index;
      used.add(index);
    }
  }

  const unmapped = headers.filter((_, i) => !used.has(i));
  return { mapping, unmapped };
}

/** Parses CSV text into rows. Never touches the database. */
export function parseCsv(input: string): ParseResult {
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];

  // Normalise newlines, then split. A trailing newline must not become a row.
  const lines = input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { rows, issues: [{ line: 0, message: 'The file is empty.' }], total: 0 };
  }

  // A BOM at the start of an Excel-exported CSV breaks the first header name.
  const first = lines[0].replace(/^\uFEFF/, '');

  // Detect a header row: if the first cell is not a plausible title, treat the
  // whole file as headerless single-column titles.
  const firstCells = splitCsvLine(first);
  const looksLikeHeader = COLUMN_ALIASES.title.some((a) =>
    firstCells[0].toLowerCase().replace(/[\s_-]+/g, ' ').trim().includes(a)
  );

  let mapping: ColumnMapping;
  let startIndex: number;

  if (looksLikeHeader) {
    mapping = detectColumns(first).mapping;
    startIndex = 1;
    // A file with only a title column still has to work.
    if (mapping.title === undefined) mapping = { title: 0 };
  } else {
    mapping = { title: 0 };
    startIndex = 0;
  }

  let total = 0;

  for (let i = startIndex; i < lines.length; i++) {
    total++;
    const lineNo = i + 1;

    if (total > IMPORT_MAX_ROWS) {
      issues.push({
        line: lineNo,
        message: `Stopped after ${IMPORT_MAX_ROWS} rows. Split the file into smaller batches.`,
      });
      break;
    }

    const cells = splitCsvLine(lines[i]);
    const title = (cells[mapping.title ?? 0] ?? '').trim().slice(0, MAX_TITLE_LENGTH);

    if (!title) {
      issues.push({ line: lineNo, message: 'No game title found in this row.' });
      continue;
    }

    const get = (field: keyof ColumnMapping) => {
      const idx = mapping[field];
      return idx === undefined ? undefined : cells[idx];
    };

    const reviewRaw = get('review');
    const review =
      reviewRaw && reviewRaw.trim().length > 0
        ? reviewRaw.trim().slice(0, MAX_REVIEW_LENGTH)
        : null;

    rows.push({
      line: lineNo,
      title,
      rating: parseRating(get('rating')),
      status: parseStatus(get('status')),
      playedOn: parseDate(get('playedOn')),
      review,
      playtimeHours: parseHours(get('playtimeHours')),
    });
  }

  return { rows, issues, total };
}

/**
 * Parses Backlog's XML export.
 *
 * Hand-rolled rather than via DOMParser because this runs in a Server Action and
 * the edge/Node runtimes differ in what they expose; also because we need to
 * reject anything that is not a flat `<game>` list rather than half-parse it.
 *
 * XML entities are decoded, which matters because a review containing
 * `&amp;` is common and would otherwise be stored with the entity intact.
 */
export function parseBacklogXml(input: string): ParseResult {
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  let total = 0;

  const gameBlocks = input.match(/<game\b[^>]*>[\s\S]*?<\/game>/gi) ?? [];

  if (gameBlocks.length === 0) {
    return {
      rows,
      issues: [{ line: 0, message: 'No <game> elements found. Is this a Backlog export?' }],
      total: 0,
    };
  }

  const field = (block: string, tag: string): string | null => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) return null;
    return decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim());
  };

  for (const block of gameBlocks) {
    total++;

    if (total > IMPORT_MAX_ROWS) {
      issues.push({
        line: total,
        message: `Stopped after ${IMPORT_MAX_ROWS} games.`,
      });
      break;
    }

    const title = field(block, 'name');
    if (!title) {
      issues.push({ line: total, message: 'This <game> has no <name>.' });
      continue;
    }

    rows.push({
      line: total,
      title: title.slice(0, MAX_TITLE_LENGTH),
      rating: parseRating(field(block, 'rating')),
      status: parseStatus(field(block, 'status')),
      playedOn: parseDate(field(block, 'dateplayed')),
      review: (() => {
        const r = field(block, 'review');
        return r && r.length > 0 ? r.slice(0, MAX_REVIEW_LENGTH) : null;
      })(),
      playtimeHours: parseHours(field(block, 'hours') ?? field(block, 'playtime')),
    });
  }

  return { rows, issues, total };
}

/** Decodes the five XML entities plus numeric references. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A plain list of titles, one per line. The lowest common denominator. */
export function parseTitleList(input: string): ParseResult {
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  let total = 0;

  const lines = input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  for (const line of lines) {
    total++;
    if (total > IMPORT_MAX_ROWS) {
      issues.push({ line: total, message: `Stopped after ${IMPORT_MAX_ROWS} games.` });
      break;
    }

    // Strip a leading bullet or numbering, which is what people get when they
    // copy a list out of a document.
    const title = line
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
      .trim()
      .slice(0, MAX_TITLE_LENGTH);

    if (!title) {
      issues.push({ line: total, message: 'Empty line.' });
      continue;
    }

    rows.push({
      line: total,
      title,
      rating: null,
      status: 'backlog',
      playedOn: null,
      review: null,
      playtimeHours: null,
    });
  }

  return { rows, issues, total };
}

/** Picks a parser by file extension, falling back to content sniffing. */
export function parseImport(
  filename: string,
  content: string
): ParseResult {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.xml')) return parseBacklogXml(content);
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return lower.endsWith('.csv') ? parseCsv(content) : parseTitleList(content);
  }

  // No usable extension: sniff.
  if (/<game\b/i.test(content.slice(0, 2000))) return parseBacklogXml(content);
  if (content.includes(',') || content.includes('"')) return parseCsv(content);
  return parseTitleList(content);
}

/** Re-exported so the import UI can validate a game id the same way. */
export { validateGameId };